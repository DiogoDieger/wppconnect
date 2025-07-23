const express = require('express');
const app = express();
const wppconnect = require('@wppconnect-team/wppconnect');
const WEBHOOK_URL = 'https://afbdd0613524.ngrok-free.app/api/whatsappwebhook'; // substitua pela sua!
const axios = require('axios');

// Objeto para armazenar múltiplas instâncias, cada uma por sessão
const instancias = {};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Função para criar ou retornar uma instância existente
async function getOrCreateSession(sessionName) {
  if (instancias[sessionName]) {
    return instancias[sessionName];
  }
  const client = await wppconnect.create({
    session: sessionName,
    catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
      console.log(`QR Code para sessão ${sessionName}:`);
      console.log(asciiQR);
    },
    statusFind: (statusSession, session) => {
      console.log(`Status da sessão ${session}: ${statusSession}`);
    },
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
  // preciso de um log para o corpo da mensagem que esta sendo enviaada , e qual sessao esta enviando

  client.onMessage(async (message) => {
    console.log(`Mensagem recebida na sessão ${sessionName}:`, message.content);
    axios
      .post(WEBHOOK_URL, {
        event: 'received',
        session: sessionName,
        message,
      })
      .catch(console.error);
  });
  instancias[sessionName] = client;
  return client;
}

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
  // Log da sessão e body da mensagem
  console.log(`[ENVIANDO MENSAGEM] Sessão: ${sessionName} | Body:`, req.body);
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

// Não inicializa nenhuma sessão automaticamente
// O servidor só inicia
const porta = '3003';
var server = app.listen(porta);
console.log('Servidor iniciado na porta %s', server.address().port);
