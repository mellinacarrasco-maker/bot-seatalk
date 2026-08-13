const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// Credenciais do SeaTalk
const SEATALK_APP_ID = 'ODU8NjUyODQ4NzE1';
const SEATALK_APP_SECRET = 'lOt0nyf8fQek0P0LkeTkomA3IYYkiLNe';
const AUTH_URL = 'https://openapi.seatalk.io/auth/app_access_token';
const PRIVATE_MSG_URL = 'https://openapi.seatalk.io/messaging/v2/single_chat';
const GROUP_MSG_URL = 'https://openapi.seatalk.io/messaging/v2/group_chat';

const SPREADSHEET_ID = '1MMyWOPR6JxAxdo39g7OLawQV72WKXqo0KK6xftdmDuc';
const SHEET_NAME = 'base_RR';

async function getGoogleSheetsClient() {
  const credentialsJson = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: credentialsJson.client_email,
      private_key: credentialsJson.private_key,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getSeaTalkToken() {
  const res = await axios.post(AUTH_URL, {
    app_id: SEATALK_APP_ID,
    app_secret: SEATALK_APP_SECRET
  });
  return res.data.app_access_token || res.data.access_token;
}

function formatarStatusReembolso(solution, amount, date) {
  let statusFormatado = solution || 'Pendente/Outro';
  if (solution && solution.trim().toUpperCase() === 'REFUND_ONLY') {
    statusFormatado = 'RR Pago';
  }
  let detalhes = [];
  if (amount) detalhes.push(`R$ ${amount}`);
  if (date) detalhes.push(`em ${date}`);
  return detalhes.length > 0 ? `${statusFormatado} (${detalhes.join(' ')})` : statusFormatado;
}

async function buscarCasoPorProtocolo(protocolo) {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:P`,
  });
  const rows = res.data.values;
  if (!rows || rows.length === 0) return null;
  const headers = rows[0];
  const idxProtocolo = headers.indexOf('Protocolo');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][idxProtocolo] === protocolo) {
      let rowData = {};
      headers.forEach((h, idx) => { rowData[h] = rows[i][idx] || ''; });
      return rowData;
    }
  }
  return null;
}

app.all('/seatalk-webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const query = req.query || {};

    // 1. Desafio de Verificação do SeaTalk
    const challenge = body.seatalk_challenge || (body.event && body.event.seatalk_challenge) || query.seatalk_challenge;
    if (challenge || body.event_type === 'event_verification') {
      return res.status(200).json({ seatalk_challenge: challenge });
    }

    console.log('Evento Recebido:', JSON.stringify(body));

    const eventType = body.event_type;
    const eventData = body.event || {};
    const messageObj = eventData.message || {};
    const messageText = (messageObj.text && messageObj.text.content) ? messageObj.text.content : '';

    const matchProtocolo = messageText.match(/\b\d+\/\d+\b/);

    if (matchProtocolo) {
      const protocolo = matchProtocolo[0];
      console.log(`Procurando protocolo: ${protocolo}`);

      const dadosCaso = await buscarCasoPorProtocolo(protocolo);
      
      let textoResposta = '';
      if (dadosCaso) {
        const solicitacaoText = dadosCaso['Solicitação a empresa'] || '';
        const pedeReembolso = solicitacaoText.toLowerCase().includes('reembolso') ? 'SIM' : 'NÃO';
        const statusSistema = formatarStatusReembolso(
          dadosCaso['return_solution'],
          dadosCaso['refund_amount'],
          dadosCaso['return_refund_paid_datetime']
        );

        textoResposta = `• **Protocolo:** ${dadosCaso['Protocolo']}\n`;
        textoResposta += `• **Número do Pedido:** ${dadosCaso['order_sn']}\n`;
        textoResposta += `• **Pede Reembolso?:** ${pedeReembolso}\n`;
        textoResposta += `• **Resumo da Solicitação:** ${solicitacaoText}\n`;
        textoResposta += `• **Status Reembolso Sistema:** ${statusSistema}`;
      } else {
        textoResposta = `⚠️ Protocolo **${protocolo}** não foi encontrado na base de dados.`;
      }

      const token = await getSeaTalkToken();

      // RESPONDER EM CHAT PRIVADO (1x1)
      if (eventType === 'message_from_bot_subscriber') {
        const seatalkId = eventData.seatalk_id;
        await axios.post(
          PRIVATE_MSG_URL,
          {
            seatalk_id: seatalkId,
            message: {
              tag: 'interactive_message',
              interactive_message: {
                elements: [{ element_type: 'description', description: { format: 1, text: textoResposta } }]
              }
            }
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log('Resposta enviada no chat privado!');
      }

      // RESPONDER EM GRUPO
      if (
        eventType === 'new_mentioned_message_received_from_group_chat' ||
        eventType === 'message_from_bot_subscriber_in_group_chat'
      ) {
        const groupId = messageObj.group_id;
        await axios.post(
          GROUP_MSG_URL,
          {
            group_id: groupId,
            message: {
              tag: 'interactive_message',
              interactive_message: {
                elements: [{ element_type: 'description', description: { format: 1, text: textoResposta } }]
              }
            }
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log('Resposta enviada no chat de grupo!');
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no processamento:', error);
    return res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor rodando na porta ${PORT}`));
