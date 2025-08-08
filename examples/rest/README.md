# API de Campanhas WhatsApp

Esta API permite disparar campanhas de mensagens em background com controle de fila e delays.

## Endpoints Principais

### 1. Disparar Campanha

**POST** `/:session/dispatch-campaign`

Dispara uma campanha em background para uma lista de contatos.

#### Exemplo de Request:

```json
{
  "campaign": {
    "id": "campaign-123",
    "name": "Campanha de Boas-vindas",
    "delay": 30000
  },
  "templates": [
    {
      "id": "template-1",
      "name": "Template de Boas-vindas",
      "messages": [
        {
          "text": "Olá! Bem-vindo ao nosso serviço!",
          "audioUrl": null,
          "imageUrl": null,
          "documentUrl": null
        },
        {
          "text": "Aqui está nosso catálogo:",
          "audioUrl": null,
          "imageUrl": "https://exemplo.com/catalogo.jpg",
          "documentUrl": null
        },
        {
          "text": "Qualquer dúvida, estamos aqui!",
          "audioUrl": null,
          "imageUrl": null,
          "documentUrl": null
        }
      ]
    }
  ],
  "contacts": ["5511999999999", "5511888888888", "5511777777777"]
}
```

#### Response:

```json
{
  "status": true,
  "message": "Campanha iniciada com sucesso",
  "campaignId": "campaign_1703123456789_abc123def",
  "totalContacts": 3,
  "totalTemplates": 1,
  "estimatedDuration": "45 segundos"
}
```

### 2. Verificar Status da Campanha

**GET** `/campaign/:campaignId/status`

#### Response:

```json
{
  "status": true,
  "campaignId": "campaign_1703123456789_abc123def",
  "campaignStatus": "running",
  "progress": 66,
  "processedContacts": 2,
  "totalContacts": 3,
  "results": [
    {
      "success": true,
      "messageId": "msg_123",
      "contact": "5511999999999",
      "message": "Olá! Bem-vindo ao nosso serviço!"
    }
  ],
  "startTime": "2023-12-21T10:30:00.000Z",
  "endTime": null,
  "duration": null,
  "error": null
}
```

### 3. Cancelar Campanha

**DELETE** `/campaign/:campaignId/cancel`

#### Response:

```json
{
  "status": true,
  "message": "Campanha cancelada com sucesso",
  "campaignId": "campaign_1703123456789_abc123def"
}
```

### 4. Listar Campanhas Ativas

**GET** `/campaigns/active`

#### Response:

```json
{
  "status": true,
  "activeCampaigns": [
    {
      "campaignId": "campaign_1703123456789_abc123def",
      "status": "running",
      "processedContacts": 2,
      "totalContacts": 3,
      "startTime": "2023-12-21T10:30:00.000Z"
    }
  ],
  "totalActive": 1
}
```

## Como Funciona

1. **Delay entre mensagens do template**: 5 segundos
2. **Delay entre contatos**: Configurado na campanha (padrão: 30 segundos)
3. **Processamento em background**: A campanha roda independentemente
4. **Controle de fila**: Múltiplas campanhas podem rodar simultaneamente
5. **Monitoramento**: Status em tempo real via API

## Tipos de Mensagem Suportados

- **Texto simples**: `text`
- **Imagem**: `imageUrl` + `text` (caption)
- **Áudio**: `audioUrl`
- **Documento**: `documentUrl` + `text` (caption)

## Exemplo de Uso com cURL

```bash
# Disparar campanha
curl -X POST http://localhost:3003/session1/dispatch-campaign \
  -H "Content-Type: application/json" \
  -d '{
    "campaign": {
      "id": "campaign-123",
      "name": "Teste",
      "delay": 30000
    },
    "templates": [
      {
        "id": "template-1",
        "name": "Template Teste",
        "messages": [
          {
            "text": "Olá! Esta é uma mensagem de teste."
          }
        ]
      }
    ],
    "contacts": ["5511999999999"]
  }'

# Verificar status
curl http://localhost:3003/campaign/campaign_1703123456789_abc123def/status

# Cancelar campanha
curl -X DELETE http://localhost:3003/campaign/campaign_1703123456789_abc123def/cancel
```
