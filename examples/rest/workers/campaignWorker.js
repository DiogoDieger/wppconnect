// workers/campaignWorker.js
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const { DateTime } = require('luxon');

const prisma = new PrismaClient();

// API externa (ajustado para sua porta atual)
const WHATSAPP_EXTERNAL_API =
  process.env.WHATSAPP_EXTERNAL_API || 'http://localhost:3001';

// Limite opcional de campanhas em paralelo (0 = ilimitado, “esponja total”)
const MAX_CAMPAIGN_CONCURRENCY = Number(
  process.env.MAX_CAMPAIGN_CONCURRENCY || 0
);

// Quanto tempo até “reviver” mensagens travadas em processing (ms)
const PROCESSING_TTL_MS = Number(
  process.env.PROCESSING_TTL_MS || 30 * 60 * 1000
); // 30min

function parsePayload(raw) {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.type) return obj;
  } catch {}
  return { type: 'text', text: String(raw ?? '') };
}

function filenameFromUrl(u, fallback) {
  try {
    const last = u.split('?')[0].split('/').pop();
    return last || fallback;
  } catch {
    return fallback;
  }
}

function renderTemplate(text, contactData) {
  if (!text) return '';
  return text.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    return contactData[key] ?? '';
  });
}

/**
 * Converte horário UTC para horário do Brasil (America/Sao_Paulo)
 * @param {Date|string} utcDate - Data/hora em UTC
 * @returns {Date} - Data/hora convertida para o horário do Brasil
 */
function convertUTCToBrazilTime(utcDate) {
  if (!utcDate) return new Date();

  // Converte para DateTime do Luxon em UTC
  const utcDateTime = DateTime.fromJSDate(
    utcDate instanceof Date ? utcDate : new Date(utcDate),
    { zone: 'utc' }
  );

  // Converte para horário do Brasil
  const brazilDateTime = utcDateTime.setZone('America/Sao_Paulo');

  // Retorna como Date JavaScript
  return brazilDateTime.toJSDate();
}

/**
 * Obtém a data/hora atual no horário do Brasil
 * @returns {Date} - Data/hora atual no horário do Brasil
 */
function getCurrentBrazilTime() {
  return DateTime.now().setZone('America/Sao_Paulo').toJSDate();
}

// Revive mensagens “presas” em processing há muito tempo
async function reviveStuckProcessing() {
  try {
    const cutoff = new Date(Date.now() - PROCESSING_TTL_MS);
    const res = await prisma.campaignDispatch.updateMany({
      where: { status: 'processing', updatedAt: { lt: cutoff } },
      data: { status: 'pending' },
    });
    if (res.count > 0) {
      console.log(
        `♻️  Revividas ${res.count} mensagens presas em 'processing' (voltaram para 'pending').`
      );
    }
  } catch (err) {
    console.error('⚠️ Erro ao reviver processing antigos:', err.message);
  }
}

/**
 * Claim atômico (via transação) do próximo CONTATO dessa campanha:
 * 1) encontra 1 dispatch pendente e pronto (respeita scheduledAt)
 * 2) marca TODOS desse contato/campanha/sessionName como 'processing'
 * 3) retorna o batch desse contato + dados do contato
 *
 * Observação: usamos apenas o status 'processing' como “lock”.
 * Em corrida, se outro worker atualizar antes, o updateMany aqui vai retornar 0 e voltamos null.
 */
async function claimNextContactBatch(campaignId) {
  // Usa horário do Brasil para comparações
  const now = getCurrentBrazilTime();

  return prisma.$transaction(
    async (tx) => {
      const first = await tx.campaignDispatch.findFirst({
        where: {
          campaignId,
          status: 'pending',
          OR: [
            { scheduledAt: null },
            {
              scheduledAt: {
                lte: now, // Agora compara com horário do Brasil
              },
            },
          ],
        },
        orderBy: [
          { contact: 'asc' },
          { messageOrder: 'asc' },
          { createdAt: 'asc' },
        ],
      });

      if (!first) return null;

      const claimTime = getCurrentBrazilTime();

      const upd = await tx.campaignDispatch.updateMany({
        where: {
          campaignId,
          contact: first.contact,
          sessionName: first.sessionName,
          status: 'pending',
          OR: [
            { scheduledAt: null },
            {
              scheduledAt: {
                lte: now, // Agora compara com horário do Brasil
              },
            },
          ],
        },
        data: { status: 'processing', updatedAt: getCurrentBrazilTime() },
      });

      if (upd.count === 0) {
        // corrida: alguém pegou antes
        return null;
      }

      // Busca SOMENTE o que acabamos de “pegar” (heurística pelo updatedAt >= claimTime)
      const batch = await tx.campaignDispatch.findMany({
        where: {
          campaignId,
          contact: first.contact,
          sessionName: first.sessionName,
          status: 'processing',
          updatedAt: { gte: claimTime },
        },
        orderBy: { messageOrder: 'asc' },
      });

      const contactData = await tx.segmentContact.findFirst({
        where: { phone: first.contact },
        select: { name: true, email: true, empresa: true },
      });

      return {
        contact: first.contact,
        sessionName: first.sessionName,
        contactData,
        batch,
      };
    },
    { timeout: 15000 }
  );
}

/**
 * Processa 1 campanha em loop: pega um contato por vez (claim) e envia todas as mensagens desse contato,
 * respeitando o delay entre mensagens (delay) e entre contatos (contactDelay).
 */
async function processCampaign(campaignId) {
  console.log(`🚀 Iniciando loop da campanha ${campaignId}`);

  // Consulta inicial de delays e status
  let campaign;
  try {
    campaign = await prisma.campaing.findUnique({
      where: { id: campaignId },
      select: { delay: true, contactDelay: true, status: true },
    });
  } catch (err) {
    console.error(`⚠️ [${campaignId}] Erro ao buscar campanha:`, err.message);
    return;
  }

  if (!campaign) {
    console.log(`⚠️ [${campaignId}] Campanha não encontrada. Encerrando.`);
    return;
  }

  while (true) {
    try {
      // Recarrega status/config a cada iteração
      campaign = await prisma.campaing.findUnique({
        where: { id: campaignId },
        select: { delay: true, contactDelay: true, status: true },
      });

      if (!campaign || campaign.status === 'paused') {
        console.log(
          `⏸ [${campaignId}] Campanha pausada/indisponível. Aguardando 10s...`
        );
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }

      const delayMs = Number(campaign?.delay ?? 30000);
      const contactDelayMs = Number(campaign?.contactDelay ?? 0);

      const claim = await claimNextContactBatch(campaignId);

      if (!claim || !claim.batch?.length) {
        // Nada pronto agora: termina o loop dessa campanha.
        console.log(
          `✅ [${campaignId}] Sem pendentes prontos. Encerrando loop da campanha.`
        );
        return;
      }

      const { contact, contactData, batch } = claim;
      const cleanNumber = String(contact).replace(/[^\d]/g, '');

      const currentBrazilTime = DateTime.now()
        .setZone('America/Sao_Paulo')
        .toFormat('dd/MM/yyyy HH:mm:ss');
      console.log(
        `📦 [${campaignId}] Processando ${batch.length} mensagens do contato ${cleanNumber} (Horário Brasil: ${currentBrazilTime})`
      );

      for (const dispatch of batch) {
        const payload = parsePayload(dispatch.message);

        try {
          let res;

          switch (payload.type) {
            case 'image':
              res = await axios.post(
                `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/sendimage`,
                {
                  telnumber: cleanNumber,
                  imagePath: payload.imageUrl,
                  filename: filenameFromUrl(payload.imageUrl, 'imagem.jpg'),
                  caption: payload.text || '',
                }
              );
              break;

            case 'video':
              res = await axios.post(
                `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/sendvideo`,
                {
                  telnumber: cleanNumber,
                  videoPath: payload.videoUrl,
                  filename: filenameFromUrl(payload.videoUrl, 'video.mp4'),
                  caption: payload.text || '',
                }
              );
              break;

            case 'audio':
              res = await axios.post(
                `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/sendptt`,
                { telnumber: cleanNumber, audioPath: payload.audioUrl }
              );
              break;

            case 'document':
              res = await axios.post(
                `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/senddocument`,
                {
                  telnumber: cleanNumber,
                  filePath: payload.documentUrl,
                  filename: filenameFromUrl(payload.documentUrl, 'documento'),
                  caption: payload.text || '',
                }
              );
              break;

            case 'text':
            default: {
              const finalMessage = renderTemplate(payload.text, {
                nome: contactData?.name,
                email: contactData?.email,
                empresa: contactData?.empresa,
              });

              res = await axios.post(
                `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/sendmessage`,
                { telnumber: cleanNumber, message: finalMessage }
              );
            }
          }

          if (res?.data?.status) {
            await prisma.campaignDispatch.update({
              where: { id: dispatch.id },
              data: { status: 'sent', error: null },
            });
            console.log(
              `✅ [${campaignId}] Enviado (${payload.type}) → ${cleanNumber}`
            );
          } else {
            throw new Error(res?.data?.message || 'Falha no envio');
          }
        } catch (err) {
          console.error(
            `❌ [${campaignId}] Erro ao enviar para ${cleanNumber}:`,
            err.message
          );
          try {
            await prisma.campaignDispatch.update({
              where: { id: dispatch.id },
              data: { status: 'failed', error: String(err.message || err) },
            });
          } catch (e) {
            console.error('⚠️ Erro ao marcar como failed:', e.message);
          }
        }

        // Delay entre mensagens do mesmo contato
        if (delayMs > 0) {
          console.log(
            `⏳ [${campaignId}] Aguardando ${Math.ceil(delayMs / 1000)}s...`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      // Delay entre contatos dessa campanha
      if (contactDelayMs > 0) {
        console.log(
          `⏳ [${campaignId}] Aguardando ${Math.ceil(
            contactDelayMs / 1000
          )}s antes do próximo contato...`
        );
        await new Promise((resolve) => setTimeout(resolve, contactDelayMs));
      }
    } catch (loopErr) {
      console.error(
        `💥 [${campaignId}] Erro no loop da campanha:`,
        loopErr.message
      );
      // Evita loop quente em erro inesperado
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/**
 * Orquestrador “esponja”: procura campanhas com pendentes prontos e
 * inicia um loop por campanha (em paralelo), respeitando MAX_CAMPAIGN_CONCURRENCY.
 */
const runningCampaigns = new Set();
const ORCHESTRATOR_TICK_MS = Number(process.env.ORCHESTRATOR_TICK_MS || 3000);

async function orchestrate() {
  await reviveStuckProcessing();

  try {
    // Usa horário do Brasil para comparações
    const now = getCurrentBrazilTime();
    const currentBrazilTime = DateTime.now()
      .setZone('America/Sao_Paulo')
      .toFormat('dd/MM/yyyy HH:mm:ss');
    console.log(
      `🕐 Orquestrador executando - Horário Brasil: ${currentBrazilTime}`
    );
    const rows = await prisma.campaignDispatch.findMany({
      where: {
        status: 'pending',
        OR: [
          { scheduledAt: null },
          {
            scheduledAt: {
              lte: now, // Agora compara com horário do Brasil
            },
          },
        ],
      },
      select: { campaignId: true },
      distinct: ['campaignId'],
    });

    const availableCampaigns = rows.map((r) => r.campaignId);

    for (const campaignId of availableCampaigns) {
      if (runningCampaigns.has(campaignId)) continue;

      if (
        MAX_CAMPAIGN_CONCURRENCY > 0 &&
        runningCampaigns.size >= MAX_CAMPAIGN_CONCURRENCY
      ) {
        break; // limite global atingido
      }

      runningCampaigns.add(campaignId);
      processCampaign(campaignId)
        .catch((e) =>
          console.error(`💥 Erro no processCampaign(${campaignId}):`, e.message)
        )
        .finally(() => {
          runningCampaigns.delete(campaignId);
        });
    }
  } catch (err) {
    console.error('⚠️ Erro no orchestrate:', err.message);
  } finally {
    setTimeout(orchestrate, ORCHESTRATOR_TICK_MS);
  }
}

// Inicia o orquestrador
orchestrate();
console.log('🧽 CampaignWorker (multi-campanhas paralelas) iniciado!');
