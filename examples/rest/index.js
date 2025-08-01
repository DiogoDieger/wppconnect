const express = require('express');
const app = express();
const wppconnect = require('@wppconnect-team/wppconnect');
const WEBHOOK_URL = 'http://localhost:3000/api/whatsappwebhook'; // substitua pela sua!
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

const qrcodesTemp = {};
const instancias = {};
const sessionStatus = {}; // Para acompanhar o status de criação das sessões
async function waitForQrCode(client, timeout = 15000, interval = 500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (client.qrCodeData && client.qrCodeData.base64Image) {
        return resolve(client.qrCodeData);
      }
      if (Date.now() - started > timeout) {
        return resolve(null); // não rejeita para lógica padrão
      }
      setTimeout(check, interval);
    };
    check();
  });
}

// Função para limpar sessões antigas
function cleanupSession(sessionName) {
  try {
    const sessionDir = path.join(__dirname, 'tokens', sessionName);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`Sessão ${sessionName} limpa`);
    }
  } catch (error) {
    console.error(`Erro ao limpar sessão ${sessionName}:`, error);
  }
}

// Configuração do CORS - deve vir antes de outros middlewares
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );

  // Responde imediatamente para requisições OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Função para processar mensagens de documento
function processDocumentMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    document: {
      filename: message.filename,
      caption: message.caption || '',
      mimetype: message.mimetype,
      size: message.size,
      pageCount: message.pageCount || null,
      downloadUrl: message.deprecatedMms3Url || null,
      directPath: message.directPath || null,
      mediaKey: message.mediaKey || null,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}

// Função para processar outros tipos de mensagem
function processRegularMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    body: message.body,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}

// Função para processar mensagens de imagem
function processImageMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    image: {
      caption: message.caption || '',
      mimetype: message.mimetype,
      size: message.size || null,
      downloadUrl: message.deprecatedMms3Url || null,
      directPath: message.directPath || null,
      mediaKey: message.mediaKey || null,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}

// Função para processar mensagens de áudio
function processAudioMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    audio: {
      mimetype: message.mimetype,
      size: message.size || null,
      duration: message.duration || null,
      ptt: message.ptt || false,
      downloadUrl: message.deprecatedMms3Url || null,
      directPath: message.directPath || null,
      mediaKey: message.mediaKey || null,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}

// Função para processar mensagens de vídeo
function processVideoMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    video: {
      caption: message.caption || '',
      mimetype: message.mimetype,
      size: message.size || null,
      duration: message.duration || null,
      downloadUrl: message.deprecatedMms3Url || null,
      directPath: message.directPath || null,
      mediaKey: message.mediaKey || null,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}
async function syncQrCodeState(sessionName, client) {
  const state = await client.getConnectionState();
  // Atualiza o estado atual dentro do cache, se já existir
  if (qrcodesTemp[sessionName]) {
    qrcodesTemp[sessionName].connectionState = state;
  }
}

// Função para criar sessão em background
async function createSessionInBackground(sessionName) {
  try {
    sessionStatus[sessionName] = {
      status: 'creating',
      message: 'Iniciando criação da sessão...',
    };

    cleanupSession(sessionName);

    let qrCodeData = null;
    let clientInstance = null;
    let qrCodeDataTemp = null;
    const QRCODE_LIFETIME = 40 * 1000;

    const catchQR = (base64Qr, asciiQR, attempts, urlCode) => {
      const expiresAt = Date.now() + QRCODE_LIFETIME;
      const qr = {
        base64Image: base64Qr,
        urlCode: urlCode,
        asciiQR: asciiQR,
        attempts: attempts,
        expiresAt,
      };
      qrcodesTemp[sessionName] = qr;
      if (client) client.qrCodeData = qr;
      sessionStatus[sessionName] = {
        status: 'qr_ready',
        message: 'QR Code gerado com sucesso',
      };
      console.log('QR Code capturado e armazenado');
    };

    const client = await wppconnect.create({
      session: sessionName,
      catchQR,
      statusFind: (statusSession, session) => {
        sessionStatus[sessionName] = {
          status: 'QR_CODE',
          message: `Status: ${statusSession}`,
        };
      },
      headless: true,
      devtools: false,
      useChrome: true,
      debug: false,
      logQR: true,
      browserWS: '',
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--user-data-dir=' + path.join(__dirname, 'tokens', sessionName),
      ],
      puppeteerOptions: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection',
        ],
      },
      disableWelcome: false,
      updatesLog: true,
      autoClose: 240000,
      tokenStore: 'file',
      folderNameToken: './tokens',
    });

    clientInstance = client;
    client.qrCodeData = qrCodeData;

    if (qrCodeDataTemp) client.qrCodeData = qrCodeDataTemp;

    client.onMessage(async (message) => {
      let processedMessage;

      if (message.type === 'document') {
        processedMessage = processDocumentMessage(message);
        processedMessage.document.localDownloadUrl = `http://localhost:3003/${sessionName}/downloadmedia/${message.id}`;
        console.log(`📄 Documento recebido na sessão ${sessionName}:`, {
          arquivo: processedMessage.document.filename,
          tamanho: processedMessage.document.size,
          remetente: processedMessage.sender.name,
        });
      } else if (message.type === 'image') {
        processedMessage = processImageMessage(message);
        processedMessage.image.localDownloadUrl = `http://localhost:3003/${sessionName}/downloadmedia/${message.id}`;
        console.log(`🖼️ Imagem recebida na sessão ${sessionName}:`, {
          remetente: processedMessage.sender.name,
        });
      } else if (message.type === 'audio') {
        processedMessage = processAudioMessage(message);
        processedMessage.audio.localDownloadUrl = `http://localhost:3003/${sessionName}/downloadmedia/${message.id}`;
        console.log(`🔊 Áudio recebido na sessão ${sessionName}:`, {
          remetente: processedMessage.sender.name,
        });
      } else if (message.type === 'video') {
        processedMessage = processVideoMessage(message);
        processedMessage.video.localDownloadUrl = `http://localhost:3003/${sessionName}/downloadmedia/${message.id}`;
        console.log(`🎥 Vídeo recebido na sessão ${sessionName}:`, {
          remetente: processedMessage.sender.name,
        });
      } else {
        processedMessage = processRegularMessage(message);
        console.log(`💬 Mensagem recebida na sessão ${sessionName}:`, {
          tipo: processedMessage.type,
          corpo: processedMessage.body,
          remetente: processedMessage.sender.name,
        });
      }

      axios
        .post(WEBHOOK_URL, {
          event: 'received',
          session: sessionName,
          message: processedMessage,
        })
        .catch(console.error);
    });

    instancias[sessionName] = client;
    sessionStatus[sessionName] = {
      status: 'ready',
      message: 'Sessão criada com sucesso',
    };
    console.log(`Sessão ${sessionName} criada com sucesso em background`);

    return client;
  } catch (error) {
    sessionStatus[sessionName] = { status: 'error', message: error.message };
    console.error(`Erro ao criar sessão ${sessionName}:`, error);
    throw error;
  }
}

// Função para criar ou retornar uma instância existente
async function getOrCreateSession(sessionName) {
  if (instancias[sessionName]) {
    console.log(`Sessão ${sessionName} já existe!`);
    return instancias[sessionName];
  }

  cleanupSession(sessionName);

  let qrCodeData = null;
  let clientInstance = null;
  let qrCodeDataTemp = null;
  const QRCODE_LIFETIME = 40 * 1000;
  const catchQR = (base64Qr, asciiQR, attempts, urlCode) => {
    const expiresAt = Date.now() + QRCODE_LIFETIME;
    const qr = {
      base64Image: base64Qr,
      urlCode: urlCode,
      asciiQR: asciiQR,
      attempts: attempts,
      expiresAt,
    };
    qrcodesTemp[sessionName] = qr; // <--- Salva no cache global
    if (client) client.qrCodeData = qr;
    console.log('QR Code capturado e armazenado');
  };

  const client = await wppconnect.create({
    session: sessionName,
    catchQR,
    statusFind: (statusSession, session) => {},
    headless: true,
    devtools: false,
    useChrome: true,
    debug: false,
    logQR: true,
    browserWS: '',
    browserArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--user-data-dir=' + path.join(__dirname, 'tokens', sessionName),
    ],
    puppeteerOptions: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
      ],
    },
    disableWelcome: false,
    updatesLog: true,
    autoClose: 240000,
    tokenStore: 'file',
    folderNameToken: './tokens',
  });

  // Atualiza a referência do cliente e adiciona o QR code
  clientInstance = client;
  client.qrCodeData = qrCodeData;

  // Se o QR code foi capturado durante a criação, atribui ao cliente
  if (qrCodeDataTemp) client.qrCodeData = qrCodeDataTemp;

  client.onMessage(async (message) => {
    let processedMessage;

    // Processa diferentes tipos de mensagem
    if (message.type === 'document') {
      processedMessage = processDocumentMessage(message);
      // Adiciona URL de download local
      processedMessage.document.localDownloadUrl = `http://localhost:3003/${sessionName}/downloadmedia/${message.id}`;
      console.log(`📄 Documento recebido na sessão ${sessionName}:`, {
        arquivo: processedMessage.document.filename,
        tamanho: processedMessage.document.size,
        remetente: processedMessage.sender.name,
      });
    } else if (message.type === 'image') {
      processedMessage = processImageMessage(message);
      // Adiciona URL de download local
      processedMessage.image.localDownloadUrl = `http://localhost:3003/${sessionName}/downloadmedia/${message.id}`;
      console.log(`🖼️ Imagem recebida na sessão ${sessionName}:`, {
        remetente: processedMessage.sender.name,
      });
    } else if (message.type === 'audio') {
      processedMessage = processAudioMessage(message);
      // Adiciona URL de download local
      processedMessage.audio.localDownloadUrl = `http://localhost:3003/${sessionName}/downloadmedia/${message.id}`;
      console.log(`🔊 Áudio recebido na sessão ${sessionName}:`, {
        remetente: processedMessage.sender.name,
      });
    } else if (message.type === 'video') {
      processedMessage = processVideoMessage(message);
      // Adiciona URL de download local
      processedMessage.video.localDownloadUrl = `http://localhost:3003/${sessionName}/downloadmedia/${message.id}`;
      console.log(`🎥 Vídeo recebido na sessão ${sessionName}:`, {
        remetente: processedMessage.sender.name,
      });
    } else {
      processedMessage = processRegularMessage(message);
      console.log(`💬 Mensagem recebida na sessão ${sessionName}:`, {
        tipo: processedMessage.type,
        corpo: processedMessage.body,
        remetente: processedMessage.sender.name,
      });
    }

    // Envia para o webhook
    axios
      .post(WEBHOOK_URL, {
        event: 'received',
        session: sessionName,
        message: processedMessage,
      })
      .catch(console.error);
  });
  instancias[sessionName] = client;
  return client;
}

// Endpoint para download de mídia (documentos, imagens, áudios, vídeos)
app.get('/:session/downloadmedia/:messageId', async function (req, res) {
  const sessionName = req.params.session;
  const messageId = req.params.messageId;

  try {
    const client = await getOrCreateSession(sessionName);

    if (typeof client === 'object') {
      const status = await client.getConnectionState();
      if (status === 'CONNECTED') {
        // Busca a mensagem pelo ID
        const message = await client.getMessageById(messageId);

        if (
          message &&
          (message.type === 'document' ||
            message.type === 'image' ||
            message.type === 'audio' ||
            message.type === 'video')
        ) {
          // Faz o download do arquivo
          const buffer = await client.downloadMedia(message);

          if (buffer) {
            // Define o nome do arquivo
            let filename = message.filename;
            if (!filename) {
              const ext = message.mimetype
                ? message.mimetype.split('/')[1]
                : 'bin';
              filename = `media_${messageId}.${ext}`;
            }

            // Define os headers da resposta
            res.setHeader(
              'Content-Type',
              message.mimetype || 'application/octet-stream'
            );
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${filename}"`
            );
            res.setHeader('Content-Length', buffer.length);

            // Envia o arquivo
            res.send(buffer);
          } else {
            res.status(500).send({
              status: false,
              message: 'Erro ao fazer download da mídia',
            });
          }
        } else {
          res.status(404).send({
            status: false,
            message: 'Mensagem não encontrada ou não é uma mídia',
          });
        }
      } else {
        res.status(500).send({
          status: false,
          message: 'Cliente não conectado',
        });
      }
    } else {
      res.status(500).send({
        status: false,
        message: 'Instância não inicializada',
      });
    }
  } catch (error) {
    console.error('Erro ao fazer download:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
    });
  }
});

// Endpoint para criar nova sessão e obter QR code ou status de conexão
app.get('/:session/getconnectionstatus', async function (req, res) {
  const sessionName = req.params.session;
  let mensagemretorno = '';
  let sucesso = false;
  let qrcode = null;
  let connectionState = null;

  // Se a sessão está sendo criada em background
  if (
    sessionStatus[sessionName] &&
    sessionStatus[sessionName].status === 'creating'
  ) {
    return res.send({
      status: true,
      message: 'Sessão sendo criada em background',
      connectionState: 'CREATING',
      qrcode: null,
    });
  }

  // Se a sessão está pronta mas ainda não foi inicializada
  if (
    sessionStatus[sessionName] &&
    sessionStatus[sessionName].status === 'qr_ready'
  ) {
    if (qrcodesTemp[sessionName] && qrcodesTemp[sessionName].base64Image) {
      return res.send({
        status: true,
        message: 'QR Code disponível',
        connectionState: 'QRCODE',
        qrcode: qrcodesTemp[sessionName],
      });
    }
  }

  // Se a sessão já existe
  if (instancias[sessionName]) {
    const client = instancias[sessionName];
    connectionState = await client.getConnectionState();
    sucesso = true;

    if (connectionState === 'QRCODE') {
      await syncQrCodeState(sessionName, client);
      // Primeiro tenta usar o QR code armazenado durante a criação
      if (client.qrCodeData && client.qrCodeData.base64Image) {
        qrcode = {
          base64Image: client.qrCodeData.base64Image,
          urlCode: client.qrCodeData.urlCode,
          asciiQR: client.qrCodeData.asciiQR,
          attempts: client.qrCodeData.attempts,
        };
        mensagemretorno = 'QR Code gerado com sucesso';
      } else {
        // Se não tiver o QR code armazenado, tenta obter via getQrCode()
        try {
          const qrData = await client.getQrCode();
          if (qrData && qrData.base64Image) {
            qrcode = {
              base64Image: qrData.base64Image,
              urlCode: qrData.urlCode,
            };
            mensagemretorno = 'QR Code gerado com sucesso';
          } else {
            mensagemretorno = 'QR Code não disponível no momento';
          }
        } catch (error) {
          console.error('Erro ao obter QR code:', error);
          mensagemretorno = 'Erro ao gerar QR Code';
        }
      }
    } else {
      mensagemretorno = connectionState;
    }
  } else {
    // Se a sessão não existe, inicia a criação em background
    console.log(`Iniciando criação da sessão ${sessionName} em background...`);
    createSessionInBackground(sessionName).catch((error) => {
      console.error(
        `Erro na criação em background da sessão ${sessionName}:`,
        error
      );
    });

    return res.send({
      status: true,
      message: 'Iniciando criação da sessão em background',
      connectionState: 'CREATING',
      qrcode: null,
    });
  }

  await syncQrCodeState(sessionName, instancias[sessionName]);
  res.send({
    status: sucesso,
    message: mensagemretorno,
    connectionState: connectionState,
    qrcode: qrcode,
  });
});

// Endpoint específico para criar uma nova sessão
app.post('/:session/createsession', async function (req, res) {
  const sessionName = req.params.session;

  try {
    if (instancias[sessionName]) {
      return res.send({
        status: true,
        message: 'Sessão já existe',
        session: sessionName,
        connectionState: 'CONNECTED',
      });
    }

    if (
      sessionStatus[sessionName] &&
      sessionStatus[sessionName].status === 'creating'
    ) {
      return res.send({
        status: true,
        message: 'Sessão já está sendo criada',
        session: sessionName,
        connectionState: 'CREATING',
      });
    }

    console.log(`Iniciando criação da sessão ${sessionName} em background...`);

    // Inicia a criação em background
    createSessionInBackground(sessionName).catch((error) => {
      console.error(
        `Erro na criação em background da sessão ${sessionName}:`,
        error
      );
    });

    // Retorna imediatamente
    res.send({
      status: true,
      message: 'Criação da sessão iniciada em background',
      session: sessionName,
      connectionState: 'CREATING',
    });
  } catch (error) {
    console.error('Erro ao iniciar criação da sessão:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
      session: sessionName,
    });
  }
});

// Endpoint para verificar o status da criação da sessão
app.get('/:session/status', async function (req, res) {
  const sessionName = req.params.session;

  try {
    // Se a sessão já existe, retorna o status atual
    if (instancias[sessionName]) {
      const connectionState = await instancias[
        sessionName
      ].getConnectionState();
      return res.send({
        status: true,
        message: 'Sessão ativa',
        session: sessionName,
        connectionState: connectionState,
        sessionStatus: 'ready',
      });
    }

    // Se está sendo criada, retorna o status da criação
    if (sessionStatus[sessionName]) {
      return res.send({
        status: true,
        message: sessionStatus[sessionName].message,
        session: sessionName,
        connectionState: sessionStatus[sessionName].status.toUpperCase(),
        sessionStatus: sessionStatus[sessionName].status,
      });
    }

    // Se não existe nem está sendo criada
    res.status(404).send({
      status: false,
      message: 'Sessão não encontrada',
      session: sessionName,
    });
  } catch (error) {
    console.error('Erro ao verificar status da sessão:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
      session: sessionName,
    });
  }
});

// Endpoint para obter QR code de uma sessão
app.get('/:session/getqrcode', async function (req, res) {
  const sessionName = req.params.session;

  // 1. Primeiro tenta pelo cache global (mesmo antes do client existir)
  if (qrcodesTemp[sessionName] && qrcodesTemp[sessionName].base64Image) {
    return res.send({
      status: true,
      message: 'QR Code obtido do cache temp com sucesso',
      session: sessionName,
      connectionState: 'QRCODE',
      qrcode: qrcodesTemp[sessionName],
    });
  }

  // 2. Se não, tenta pelo client (quando já estiver inicializado)
  const client = instancias[sessionName];
  if (client) {
    const connectionState = await client.getConnectionState();
    if (connectionState === 'QRCODE') {
      if (client.qrCodeData && client.qrCodeData.base64Image) {
        return res.send({
          status: true,
          message: 'QR Code obtido do client',
          session: sessionName,
          connectionState,
          qrcode: client.qrCodeData,
        });
      }
    }
    return res.send({
      status: false,
      message: `QRCODE. Estado atual: ${connectionState}`,
      session: sessionName,
      connectionState,
    });
  }

  // 3. Se não tem nada ainda...
  res.status(404).send({
    status: false,
    message: 'QR Code não disponível ou sessão ainda sendo criada',
    session: sessionName,
  });
});

// Endpoint para limpar uma sessão
app.delete('/:session/cleansession', async function (req, res) {
  const sessionName = req.params.session;

  try {
    // Fecha a instância se existir
    if (instancias[sessionName]) {
      try {
        await instancias[sessionName].close();
        console.log(`Instância ${sessionName} fechada`);
      } catch (error) {
        console.error(`Erro ao fechar instância ${sessionName}:`, error);
      }
      delete instancias[sessionName];
    }

    // Limpa os arquivos da sessão
    cleanupSession(sessionName);

    // Limpa o status da sessão
    delete sessionStatus[sessionName];
    delete qrcodesTemp[sessionName];

    res.send({
      status: true,
      message: `Sessão ${sessionName} limpa com sucesso`,
      session: sessionName,
    });
  } catch (error) {
    console.error('Erro ao limpar sessão:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
      session: sessionName,
    });
  }
});

// Endpoint para enviar mensagem de texto
app.post('/:session/sendmessage', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  const telnumber = req.body.telnumber;
  const mensagemparaenvio = req.body.message;

  let mensagemretorno = '';
  let sucesso = false;
  if (typeof client === 'object') {
    const status = await client.getConnectionState();
    if (status === 'CONNECTED') {
      let numeroexiste = await client.checkNumberStatus(telnumber + '@c.us');
      if (numeroexiste.canReceiveMessage === true) {
        await client
          .sendText(numeroexiste.id._serialized, mensagemparaenvio)
          .then((result) => {
            console.log('Result: ', result);
            sucesso = true;

            mensagemretorno = result.id;
            axios
              .post(WEBHOOK_URL, {
                event: 'sent',
                session: sessionName,
                telnumber,
                message: mensagemparaenvio,
                result,
              })
              .catch(console.error);
          })

          .catch((erro) => {
            console.error('Error when sending: ', erro);
          });
      } else {
        mensagemretorno =
          'O numero não está disponível ou está bloqueado - The number is not available or is blocked.';
      }
    } else {
      mensagemretorno =
        'Valide sua conexao com a internet ou QRCODE - Validate your internet connection or QRCODE';
    }
  } else {
    mensagemretorno =
      'A instancia não foi inicializada - The instance was not initialized';
  }
  res.send({ status: sucesso, message: mensagemretorno });
});

// Endpoint para enviar mensagem PIX (mantido do original)
app.post('/:session/sendpixmessage', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  const telnumber = req.body.telnumber;
  const params = req.body.params;
  const options = req.body.options;
  let mensagemretorno = '';
  let sucesso = false;
  if (typeof client === 'object') {
    const status = await client.getConnectionState();
    if (status === 'CONNECTED') {
      let numeroexiste = await client.checkNumberStatus(telnumber + '@c.us');
      if (numeroexiste.canReceiveMessage === true) {
        await client
          .sendPix(numeroexiste.id._serialized, params, options)
          .then((result) => {
            sucesso = true;
            mensagemretorno = result.id;
          })
          .catch((erro) => {
            console.error('Error when sending: ', erro);
          });
      } else {
        mensagemretorno =
          'O numero não está disponível ou está bloqueado - The number is not available or is blocked.';
      }
    } else {
      mensagemretorno =
        'Valide sua conexao com a internet ou QRCODE - Validate your internet connection or QRCODE';
    }
  } else {
    mensagemretorno =
      'A instancia não foi inicializada - The instance was not initialized';
  }
  res.send({ status: sucesso, message: mensagemretorno });
});
app.post('/:session/sendptt', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  const telnumber = req.body.telnumber;
  const audioPath = req.body.audioPath; // Caminho do arquivo de áudio no servidor

  // Caminho temporário para o arquivo convertido
  const outputPath = path.join(
    path.dirname(audioPath),
    `converted_${Date.now()}.ogg`
  );

  // Função para converter o áudio para OGG/Opus
  function convertToOpus(input, output) {
    return new Promise((resolve, reject) => {
      ffmpeg(input)
        .audioCodec('libopus')
        .audioBitrate('64k')
        .audioChannels(1)
        .audioFrequency(48000)
        .format('ogg')
        .on('end', () => resolve(output))
        .on('error', reject)
        .save(output);
    });
  }

  let mensagemretorno = '';
  let sucesso = false;

  if (typeof client === 'object') {
    const status = await client.getConnectionState();
    if (status === 'CONNECTED') {
      let numeroexiste = await client.checkNumberStatus(telnumber + '@c.us');
      if (numeroexiste.canReceiveMessage === true) {
        try {
          // Converte o áudio antes de enviar
          await convertToOpus(audioPath, outputPath);

          await client
            .sendPtt(numeroexiste.id._serialized, outputPath)
            .then((result) => {
              sucesso = true;
              mensagemretorno = result.id;
              // Remove o arquivo convertido após o envio
              fs.unlinkSync(outputPath);
            })
            .catch((erro) => {
              mensagemretorno = erro;
              fs.unlinkSync(outputPath);
            });
        } catch (err) {
          mensagemretorno = 'Erro ao converter o áudio: ' + err;
        }
      } else {
        mensagemretorno = 'O número não está disponível ou está bloqueado.';
      }
    } else {
      mensagemretorno = 'Valide sua conexão com a internet ou QRCODE.';
    }
  } else {
    mensagemretorno = 'A instância não foi inicializada.';
  }
  res.send({ status: sucesso, message: mensagemretorno });
});
// Não inicializa nenhuma sessão automaticamente
// O servidor só inicia]

// Envia imagem Eduardo
app.post('/:session/sendimage', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  const telnumber = req.body.telnumber;
  const imagePath = req.body.imagePath;
  const filename = req.body.filename || 'imagem.jpg';
  const caption = req.body.caption || '';

  let mensagemretorno = '';
  let sucesso = false;
  if (typeof client === 'object') {
    const status = await client.getConnectionState();
    if (status === 'CONNECTED') {
      let numeroexiste = await client.checkNumberStatus(telnumber + '@c.us');
      if (numeroexiste.canReceiveMessage === true) {
        await client
          .sendImage(numeroexiste.id._serialized, imagePath, filename, caption)
          .then((result) => {
            sucesso = true;
            mensagemretorno = result.id;
          })
          .catch((erro) => {
            mensagemretorno = erro;
          });
      } else {
        mensagemretorno = 'O número não está disponível ou está bloqueado.';
      }
    } else {
      mensagemretorno = 'Valide sua conexão com a internet ou QRCODE.';
    }
  } else {
    mensagemretorno = 'A instância não foi inicializada.';
  }
  res.send({ status: sucesso, message: mensagemretorno });
});

app.get('/:session/history', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  const chatId = req.query.chatId; // Exemplo: '5514999999999@c.us' ou '1234567890-123456789@g.us'
  const amount = parseInt(req.query.amount) || 50; // Quantidade de mensagens (padrão: 50)

  if (!chatId) {
    return res
      .status(400)
      .send({ status: false, message: 'chatId é obrigatório' });
  }

  let messages = [];
  let sucesso = false;
  if (typeof client === 'object') {
    try {
      messages = await client.getAllMessagesInChat(
        chatId,
        true,
        true,
        amount,
        true
      );
      sucesso = true;
    } catch (err) {
      return res.status(500).send({
        status: false,
        message: 'Erro ao buscar histórico',
        error: err,
      });
    }
  }
  res.send({ status: sucesso, messages });
});

app.get('/:session/loadearlier', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  const chatId = req.query.chatId;
  if (!chatId) {
    return res
      .status(400)
      .send({ status: false, message: 'chatId é obrigatório' });
  }
  try {
    await client.loadEarlierMessages(chatId);
    res.send({
      status: true,
      message: 'Mensagens antigas carregadas para o chat ' + chatId,
    });
  } catch (err) {
    res.status(500).send({
      status: false,
      message: 'Erro ao carregar mensagens antigas',
      error: err,
    });
  }
});

// Endpoint para obter informações de mídia sem fazer download
app.get('/:session/mediainfo/:messageId', async function (req, res) {
  const sessionName = req.params.session;
  const messageId = req.params.messageId;

  try {
    const client = await getOrCreateSession(sessionName);

    if (typeof client === 'object') {
      const status = await client.getConnectionState();
      if (status === 'CONNECTED') {
        // Busca a mensagem pelo ID
        const message = await client.getMessageById(messageId);

        if (
          message &&
          (message.type === 'document' ||
            message.type === 'image' ||
            message.type === 'audio' ||
            message.type === 'video')
        ) {
          let mediaInfo = {};

          if (message.type === 'document') {
            mediaInfo = processDocumentMessage(message);
          } else if (message.type === 'image') {
            mediaInfo = processImageMessage(message);
          } else if (message.type === 'audio') {
            mediaInfo = processAudioMessage(message);
          } else if (message.type === 'video') {
            mediaInfo = processVideoMessage(message);
          }

          // Adiciona URL de download
          mediaInfo.downloadUrl = `/${sessionName}/downloadmedia/${messageId}`;

          res.send({
            status: true,
            mediaInfo,
          });
        } else {
          res.status(404).send({
            status: false,
            message: 'Mensagem não encontrada ou não é uma mídia',
          });
        }
      } else {
        res.status(500).send({
          status: false,
          message: 'Cliente não conectado',
        });
      }
    } else {
      res.status(500).send({
        status: false,
        message: 'Instância não inicializada',
      });
    }
  } catch (error) {
    console.error('Erro ao obter informações da mídia:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
    });
  }
});

const porta = '3003';
var server = app
  .listen(porta, () => {
    console.log('Servidor iniciado na porta %s', porta);
  })
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `❌ Porta ${porta} já está em uso. Tente uma porta diferente ou mate o processo que está usando a porta.`
      );
      console.error(
        'Para matar processos na porta 3003: pkill -f "node.*index.js"'
      );
    } else {
      console.error('❌ Erro ao iniciar servidor:', err.message);
    }
    process.exit(1);
  });
