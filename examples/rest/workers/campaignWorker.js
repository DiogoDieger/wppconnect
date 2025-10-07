// workers/campaignWorker.js
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();
const WHATSAPP_EXTERNAL_API = 'http://localhost:3005';

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

async function processNext() {
  const now = new Date();

  let first;
  try {
    first = await prisma.campaignDispatch.findFirst({
      where: {
        status: 'pending',
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
      },
      orderBy: [
        { campaignId: 'asc' },
        { contact: 'asc' },
        { messageOrder: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  } catch (err) {
    console.error('⚠️ Erro ao consultar Dispatch:', err.message);
    setTimeout(processNext, 10000);
    return;
  }

  if (!first) {
    console.log('⏸ Nenhuma mensagem pronta, tentando de novo em 5s...');
    setTimeout(processNext, 5000);
    return;
  }

  let contactData;
  try {
    contactData = await prisma.segmentContact.findFirst({
      where: { phone: first.contact },
      select: { name: true, email: true, empresa: true },
    });
  } catch (err) {
    console.error('⚠️ Erro ao buscar contato:', err.message);
  }

  let batch = [];
  try {
    batch = await prisma.campaignDispatch.findMany({
      where: {
        status: 'pending',
        campaignId: first.campaignId,
        contact: first.contact,
        sessionName: first.sessionName,
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
      },
      orderBy: { messageOrder: 'asc' },
    });
  } catch (err) {
    console.error('⚠️ Erro ao buscar batch:', err.message);
    setTimeout(processNext, 5000);
    return;
  }

  if (!batch.length) {
    setTimeout(processNext, 2000);
    return;
  }

  console.log(
    `📦 Processando ${batch.length} mensagens para ${first.contact} (campanha ${first.campaignId})`
  );

  // pega delay da campanha
  let campaign;
  try {
    campaign = await prisma.campaing.findUnique({
      where: { id: first.campaignId },
      select: { delay: true, contactDelay: true, status: true },
    });
  } catch (err) {
    console.error('⚠️ Erro ao buscar campanha:', err.message);
    setTimeout(processNext, 10000);
    return;
  }

  if (!campaign || campaign.status === 'paused') {
    console.log(
      `⏸ Campanha ${first.campaignId} está pausada. Tentando de novo em 10s...`
    );
    setTimeout(processNext, 10000);
    return;
  }

  const delayMs = campaign?.delay || 30000;
  const contactDelayMs = campaign?.contactDelay || 0;

  for (const dispatch of batch) {
    const payload = parsePayload(dispatch.message);
    const contact = String(dispatch.contact).replace(/[^\d]/g, '');
    const session = await prisma.whatsAppSession.findUnique({
      where: {
        id: dispatch.sessionName,
      },
    });
    try {
      let res;
      switch (payload.type) {
        case 'image':
          res = await axios.post(
            `${WHATSAPP_EXTERNAL_API}/${session.sessionName}/sendimage`,
            {
              telnumber: contact,
              imagePath: payload.imageUrl,
              filename: filenameFromUrl(payload.imageUrl, 'imagem.jpg'),
              caption: payload.text || '',
            }
          );
          break;
        case 'video':
          res = await axios.post(
            `${WHATSAPP_EXTERNAL_API}/${session.sessionName}/sendvideo`,
            {
              telnumber: contact,
              videoPath: payload.videoUrl,
              filename: filenameFromUrl(payload.videoUrl, 'video.mp4'),
              caption: payload.text || '',
            }
          );
          break;
        case 'audio':
          res = await axios.post(
            `${WHATSAPP_EXTERNAL_API}/${session.sessionName}/sendptt`,
            { telnumber: contact, audioPath: payload.audioUrl }
          );
          break;
        case 'document':
          res = await axios.post(
            `${WHATSAPP_EXTERNAL_API}/${session.sessionName}/senddocument`,
            {
              telnumber: contact,
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
            `${WHATSAPP_EXTERNAL_API}/${session.sessionName}/sendmessage`,
            { telnumber: contact, message: finalMessage }
          );
        }
      }

      if (res?.data?.status) {
        await prisma.campaignDispatch.update({
          where: { id: dispatch.id },
          data: { status: 'sent' },
        });
        console.log(`✅ Enviado (${payload.type}) para ${contact}`);
      } else {
        throw new Error(res?.data?.message || 'Falha no envio');
      }
    } catch (err) {
      console.error(`❌ Erro ao enviar para ${contact}:`, err.message);
      try {
        await prisma.campaignDispatch.update({
          where: { id: dispatch.id },
          data: { status: 'failed', error: String(err.message || err) },
        });
      } catch (e) {
        console.error('⚠️ Erro ao marcar como failed:', e.message);
      }
    }

    console.log(`⏳ Aguardando ${delayMs / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (contactDelayMs > 0) {
    console.log(
      `⏳ Esperando ${contactDelayMs / 1000}s antes do próximo contato...`
    );
    await new Promise((resolve) => setTimeout(resolve, contactDelayMs));
  }

  processNext();
}

// inicia o loop
processNext();
console.log('🚀 CampaignWorker rodando (sequência por contato/campanha)');
