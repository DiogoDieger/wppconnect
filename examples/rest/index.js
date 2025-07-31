const express = require('express');
const app = express();
const wppconnect = require('@wppconnect-team/wppconnect');
const WEBHOOK_URL = 'http://localhost:3002/api/whatsappwebhook'; // substitua pela sua!
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
// Objeto para armazenar múltiplas instâncias, cada uma por sessão
const instancias = {};

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

// Função para criar ou retornar uma instância existente
async function getOrCreateSession(sessionName) {
  if (instancias[sessionName]) {
    return instancias[sessionName];
  }
  const client = await wppconnect.create({
    session: sessionName,
    catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
      console.log(asciiQR);
    },
    statusFind: (statusSession, session) => {},
    headless: true,
    devtools: false,
    useChrome: true,
    debug: false,
    logQR: true,
    browserWS: '',
    browserArgs: [''],
    puppeteerOptions: {},
    disableWelcome: false,
    updatesLog: true,
    autoClose: 60000,
    tokenStore: 'file',
    folderNameToken: './tokens',
  });

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

// Endpoint para checar status de conexão de uma sessão
app.get('/:session/getconnectionstatus', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  let mensagemretorno = '';
  let sucesso = false;
  if (typeof client === 'object') {
    mensagemretorno = await client.getConnectionState();
    sucesso = true;
  } else {
    mensagemretorno =
      'A instancia não foi inicializada - The instance was not initialized';
  }
  res.send({ status: sucesso, message: mensagemretorno });
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
