// workers/campaignWorker.js
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();
const WHATSAPP_EXTERNAL_API = 'http://localhost:3001';

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

  const first = await prisma.campaignDispatch.findFirst({
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

  if (!first) {
    console.log(
      '⏸ Nenhuma mensagem pronta para envio, tentando de novo em 5s...'
    );
    setTimeout(processNext, 5000);
    return;
  }
  const contactData = await prisma.segmentContact.findFirst({
    where: { phone: first.contact }, // ou id, dependendo do seu schema
    select: { name: true, email: true, empresa: true },
  });
  // 2) carrega todas as mensagens desse mesmo contato dentro da mesma campanha
  const batch = await prisma.campaignDispatch.findMany({
    where: {
      status: 'pending',
      campaignId: first.campaignId,
      contact: first.contact,
      sessionName: first.sessionName,
      OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
    },
    orderBy: { messageOrder: 'asc' },
  });

  if (!batch.length) {
    setTimeout(processNext, 2000);
    return;
  }

  console.log(
    `📦 Processando ${batch.length} mensagens para contato ${first.contact} (campanha ${first.campaignId})`
  );

  // pega delay da campanha
  const campaign = await prisma.campaing.findUnique({
    where: { id: first.campaignId },
    select: { delay: true, contactDelay: true, status: true },
  });

  if (!campaign || campaign.status === 'paused') {
    console.log(
      `⏸ Campanha ${first.campaignId} está pausada. Retentando em 10s...`
    );
    setTimeout(processNext, 10000);
    return;
  }

  const delayMs = campaign?.delay || 30000; // delay entre mensagens do mesmo contato
  const contactDelayMs = campaign?.contactDelay || 0;
  console.log(delayMs, contactDelayMs);

  // 3) processa as mensagens desse contato na sequência
  for (const dispatch of batch) {
    const payload = parsePayload(dispatch.message);
    const contact = String(dispatch.contact).replace(/[^\d]/g, '');
    console.log(payload.type);
    try {
      let res;
      switch (payload.type) {
        case 'image':
          res = await axios.post(
            `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/sendimage`,
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
            `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/sendvideo`,
            {
              telnumber: contact,
              videoPath: payload.videoUrl, // 👈 campo salvo no banco
              filename: filenameFromUrl(payload.videoUrl, 'video.mp4'),
              caption: payload.text || '',
            }
          );
          break;

        case 'audio':
          res = await axios.post(
            `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/sendptt`,
            { telnumber: contact, audioPath: payload.audioUrl }
          );
          break;

        case 'document':
          res = await axios.post(
            `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/senddocument`,
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
          // 🔹 substitui variáveis no texto
          const finalMessage = renderTemplate(payload.text, {
            nome: contactData?.name,
            email: contactData?.email,
            empresa: contactData?.empresa,
          });

          res = await axios.post(
            `${WHATSAPP_EXTERNAL_API}/${dispatch.sessionName}/sendmessage`,
            { telnumber: contact, message: finalMessage }
          );
          break;
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
      await prisma.campaignDispatch.update({
        where: { id: dispatch.id },
        data: { status: 'failed', error: String(err.message || err) },
      });
      console.error(`❌ Falhou para ${contact}:`, err.message);
    }

    // delay entre mensagens do mesmo contato
    console.log(
      `⏳ Aguardando ${delayMs / 1000}s antes da próxima mensagem...`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (contactDelayMs > 0) {
    console.log(
      `⏳ Aguardando ${contactDelayMs / 1000}s antes do próximo contato...`
    );
    await new Promise((resolve) => setTimeout(resolve, contactDelayMs));
  }
  processNext();
}

// inicia o loop
processNext();
console.log('🚀 CampaignWorker rodando (sequência por contato/campanha)');
