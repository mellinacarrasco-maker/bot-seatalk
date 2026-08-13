const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// CREDENCIAIS DIRETO NO CÓDIGO
const SEATALK_APP_ID = 'ODU8NjUyODQ4NzE1';
const SEATALK_APP_SECRET = 'lOt0nyf8fQek0P0LkeTkomA3IYYkiLNe';
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
  const res = await axios.post('https://openapi.seatalk.io/auth/app_access_token', {
    app_id: SEATALK_APP_ID,
    app_secret: SEATALK_APP_SECRET
  });
  return res.data.app_access_token;
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

// ROTA DO WEBHOOK
app.all('/seatalk-webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const query = req.query || {};

    // Suporte ao Desafio / Validação do SeaTalk
    const challenge = body.seatalk_challenge || (body.event && body.event.seatalk_challenge) || query.seatalk_challenge;
    if (challenge || body.event_type === 'event_verification') {
      return res.status(200).json({ seatalk_challenge: challenge });
    }

    // EVENTO CORRETO DE MENSAGEM COM MENÇÃO NO SEATALK
    if (
      body.event_type === 'new_mentioned_message_received_from_group_chat' ||
      body.event_type === 'message_from_bot_subscriber_in_group_chat'
    ) {
      const messageText = body.event.message.text.content || '';
      const groupId = body.event.message.group_id;
      const messageId = body.event.message.message_id;
      const senderSeatalkId = body.event.message.sender_seatalk_id;

      // Extrai protocolo no formato xxxxx/xxxx
      const matchProtocolo = messageText.match(/\b\d+\/\d+\b/);

      if (matchProtocolo) {
        const protocolo = matchProtocolo[0];
        console.log(`Protocolo encontrado: ${protocolo}`);
        
        const dadosCaso = await buscarCasoPorProtocolo(protocolo);
        if (dadosCaso) {
          const solicitacaoText = dadosCaso['Solicitação a empresa'] || '';
          const pedeReembolso = solicitacaoText.toLowerCase().includes('reembolso') ? 'SIM' : 'NÃO';
          const statusSistema = formatarStatusReembolso(
            dadosCaso['return_solution'],
            dadosCaso['refund_amount'],
            dadosCaso['return_refund_paid_datetime']
          );
          
          const respostaFormatada = 
`• Protocolo: ${dadosCaso['Protocolo']}
• Número do Pedido: ${dadosCaso['order_sn']}
• Pede Reembolso?: ${pedeReembolso}
• Resumo da Solicitação: ${solicitacaoText}
• Status Reembolso Sistema: ${statusSistema}`;

          const token = await getSeaTalkToken();
          await axios.post(
            'https://openapi.seatalk.io/messaging/v2/group_chat',
            {
              group_id: groupId,
              thread_id: messageId,
              msg_type: 'text',
              text: { content: `<m seatalk_id="${senderSeatalkId}"/>\n\n${respostaFormatada}` }
            },
            { headers: { Authorization: `Bearer ${token}` } }
          );
          console.log('Resposta enviada com sucesso para o SeaTalk!');
        } else {
          console.log(`Protocolo ${protocolo} não foi encontrado na planilha.`);
        }
      }
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no processamento do webhook:', error);
    return res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor rodando na porta ${PORT}`));
