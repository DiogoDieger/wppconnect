# WPPConnect REST API Example

Este exemplo demonstra como criar uma API REST usando WPPConnect para enviar e receber mensagens do WhatsApp.

## Funcionalidades

- Múltiplas sessões do WhatsApp
- Envio de mensagens de texto
- Envio de imagens
- Envio de áudios (PTT)
- Envio de mensagens PIX
- Recebimento de mensagens via webhook
- **Processamento inteligente de documentos e mídias**
- **Download de documentos, imagens, áudios e vídeos**
- Histórico de mensagens
- Verificação de status de conexão

## Instalação

```bash
npm install
```

## Configuração

1. Configure o `WEBHOOK_URL` no arquivo `index.js` com a URL do seu webhook externo
2. Execute o servidor:

```bash
node index.js
```

## Endpoints Disponíveis

### Verificar Status da Conexão

```
GET /:session/getconnectionstatus
```

### Enviar Mensagem de Texto

```
POST /:session/sendmessage
Body: {
  "telnumber": "5511999999999",
  "message": "Sua mensagem aqui"
}
```

### Enviar Imagem

```
POST /:session/sendimage
Body: {
  "telnumber": "5511999999999",
  "imagePath": "/caminho/para/imagem.jpg",
  "filename": "imagem.jpg",
  "caption": "Legenda da imagem"
}
```

### Enviar Áudio (PTT)

```
POST /:session/sendptt
Body: {
  "telnumber": "5511999999999",
  "audioPath": "/caminho/para/audio.mp3"
}
```

### Histórico de Mensagens

```
GET /:session/history?chatId=5511999999999@c.us&amount=50
```

### **Obter Informações de Mídia**

```
GET /:session/mediainfo/:messageId
```

Retorna informações estruturadas sobre documentos, imagens, áudios ou vídeos.

### **Download de Mídia**

```
GET /:session/downloadmedia/:messageId
```

Faz o download direto do arquivo (documento, imagem, áudio ou vídeo).

## Webhook de Mensagens Recebidas

O sistema agora envia mensagens estruturadas para o webhook configurado:

### Documento Recebido

```json
{
  "event": "received",
  "session": "leonardo",
  "message": {
    "id": "false_554187984809@c.us_3A4FA28F5AEC7D155239",
    "type": "document",
    "from": "554187984809@c.us",
    "to": "554184877482@c.us",
    "timestamp": 1753566197,
    "sender": {
      "id": "554187984809@c.us",
      "name": "Curso Business",
      "pushname": "Rei do Sites"
    },
    "document": {
      "filename": "CNH-e.pdf.pdf",
      "caption": "CNH-e.pdf.pdf",
      "mimetype": "application/pdf",
      "size": 284787,
      "pageCount": 1,
      "downloadUrl": "https://mmg.whatsapp.net/...",
      "directPath": "/v/t62.7119-24/...",
      "mediaKey": "6g7fBLII/5nynfQwLBJC...",
      "localDownloadUrl": "http://localhost:3003/leonardo/downloadmedia/false_554187984809@c.us_3A4FA28F5AEC7D155239"
    },
    "isFromMe": false,
    "ack": 1
  }
}
```

### Imagem Recebida

```json
{
  "event": "received",
  "session": "leonardo",
  "message": {
    "id": "false_554187984809@c.us_...",
    "type": "image",
    "from": "554187984809@c.us",
    "to": "554184877482@c.us",
    "timestamp": 1753566197,
    "sender": {
      "id": "554187984809@c.us",
      "name": "Curso Business",
      "pushname": "Rei do Sites"
    },
    "image": {
      "caption": "Legenda da imagem",
      "mimetype": "image/jpeg",
      "size": 50000,
      "downloadUrl": "https://mmg.whatsapp.net/...",
      "directPath": "/v/t62.7119-24/...",
      "mediaKey": "...",
      "localDownloadUrl": "http://localhost:3003/leonardo/downloadmedia/false_554187984809@c.us_..."
    },
    "isFromMe": false,
    "ack": 1
  }
}
```

### Mensagem de Texto

```json
{
  "event": "received",
  "session": "leonardo",
  "message": {
    "id": "false_554187984809@c.us_...",
    "type": "chat",
    "from": "554187984809@c.us",
    "to": "554184877482@c.us",
    "timestamp": 1753566197,
    "body": "Olá, como você está?",
    "sender": {
      "id": "554187984809@c.us",
      "name": "Curso Business",
      "pushname": "Rei do Sites"
    },
    "isFromMe": false,
    "ack": 1
  }
}
```

## Melhorias Implementadas

1. **Processamento Estruturado**: Mensagens são processadas e enviadas de forma organizada para o webhook
2. **Logs Amigáveis**: Console mostra informações resumidas e relevantes
3. **Download de Mídia**: Endpoints para visualizar e baixar documentos/mídias
4. **Suporte Completo**: Documentos, imagens, áudios, vídeos são tratados adequadamente
5. **URLs de Download**: Cada mídia inclui uma URL para download direto

## Uso no Sistema Externo

Com essas melhorias, seu sistema externo pode:

1. Receber mensagens estruturadas via webhook
2. Identificar facilmente o tipo de conteúdo (documento, imagem, etc.)
3. Exibir informações relevantes (nome do arquivo, tamanho, tipo)
4. Baixar arquivos usando os endpoints de download
5. Processar diferentes tipos de mídia de forma adequada

## Exemplo de Implementação no Sistema Externo

### JavaScript/Node.js

```javascript
// Webhook receiver
app.post('/api/whatsappwebhook', (req, res) => {
  const { event, session, message } = req.body;

  if (event === 'received') {
    switch (message.type) {
      case 'document':
        console.log(`Documento recebido: ${message.document.filename}`);
        console.log(`Tamanho: ${message.document.size} bytes`);
        console.log(`Download: ${message.document.localDownloadUrl}`);

        // Para fazer download
        downloadFile(
          message.document.localDownloadUrl,
          message.document.filename
        );
        break;

      case 'image':
        console.log(`Imagem recebida de ${message.sender.name}`);
        if (message.image.caption) {
          console.log(`Legenda: ${message.image.caption}`);
        }
        break;

      case 'chat':
        console.log(`Mensagem de texto: ${message.body}`);
        break;
    }
  }

  res.status(200).send('OK');
});

async function downloadFile(url, filename) {
  const response = await fetch(url);
  const buffer = await response.buffer();
  fs.writeFileSync(`./downloads/${filename}`, buffer);
  console.log(`Arquivo ${filename} salvo!`);
}
```

### PHP

```php
<?php
// webhook.php
$input = json_decode(file_get_contents('php://input'), true);

if ($input['event'] === 'received') {
    $message = $input['message'];

    switch ($message['type']) {
        case 'document':
            $filename = $message['document']['filename'];
            $downloadUrl = $message['document']['localDownloadUrl'];

            echo "Documento recebido: $filename\n";

            // Download do arquivo
            $fileContent = file_get_contents($downloadUrl);
            file_put_contents("downloads/$filename", $fileContent);
            break;

        case 'image':
            echo "Imagem recebida\n";
            break;

        case 'chat':
            echo "Mensagem: " . $message['body'] . "\n";
            break;
    }
}
?>
```

## Comandos de Teste

### Testar envio de mensagem

```bash
curl -X POST http://localhost:3003/leonardo/sendmessage \
  -H "Content-Type: application/json" \
  -d '{
    "telnumber": "5511999999999",
    "message": "Olá! Teste de mensagem."
  }'
```

### Testar envio de imagem

```bash
curl -X POST http://localhost:3003/leonardo/sendimage \
  -H "Content-Type: application/json" \
  -d '{
    "telnumber": "5511999999999",
    "imagePath": "/caminho/para/imagem.jpg",
    "filename": "teste.jpg",
    "caption": "Imagem de teste"
  }'
```

### Verificar status de conexão

```bash
curl http://localhost:3003/leonardo/getconnectionstatus
```

### Baixar mídia (substitua MESSAGE_ID pelo ID real)

```bash
curl -O http://localhost:3003/leonardo/downloadmedia/MESSAGE_ID
```
