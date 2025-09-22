// STEP 1: 必要なライブラリを読み込む
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

// STEP 2: Firebaseの初期設定
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// STEP 3: Expressサーバーの準備
const app = express();
app.use(cors());

// --- リマインダー機能 ---
async function runReminderCheck() {
  console.log('リマインダーチェックを開始します...');
  const jstDateString = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const today = jstDateString.split(' ')[0];

  const remindersRef = db.collection('reminders');
  const snapshot = await remindersRef.where('reminderDate', '==', today).where('isSent', '==', false).get();

  if (snapshot.empty) {
    console.log('本日実行するリマインダーはありません。');
    return '本日実行するリマインダーはありませんでした。';
  }

  for (const doc of snapshot.docs) {
    const reminder = doc.data();
    console.log(`リマインダー「${reminder.submissionDeadline}」の処理を開始します。`);
    const nonSubmitters = await findNonSubmitters(reminder);
    if (nonSubmitters.length > 0) {
      await sendDiscordNotification(nonSubmitters, reminder);
      console.log('未提出者に通知を送信しました。');
    } else {
      console.log('全員提出済みです。');
    }
    await doc.ref.update({ isSent: true });
  }
  return 'リマインダー処理が完了しました。';
}

async function findNonSubmitters(reminder) {
  const membersRef = db.collection('members');
  const membersSnapshot = await membersRef.get();
  const allMembers = membersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
  const nonSubmitters = [];
  for (const member of allMembers) {
    let hasSubmitted = false;
    const startDate = new Date(reminder.scheduleStartDate);
    const endDate = new Date(reminder.scheduleEndDate);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateString = d.toLocaleDateString('sv-SE');
      const scheduleDocRef = db.collection('schedules').doc(dateString);
      const scheduleDoc = await scheduleDocRef.get();
      if (scheduleDoc.exists) {
        const data = scheduleDoc.data();
        const hasAvailability = data.availability?.[member.id]?.length > 0;
        const isUnavailable = data.unavailable?.[member.id] === true;
        if (hasAvailability || isUnavailable) {
          hasSubmitted = true;
          break;
        }
      }
    }
    if (!hasSubmitted) {
      nonSubmitters.push({ name: member.name, discordId: member.discordId });
    }
  }
  return nonSubmitters;
}

async function sendDiscordNotification(nonSubmitters, reminder) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const mentions = nonSubmitters.map(user => user.discordId ? `<@${user.discordId}>` : user.name).join(' ');
  const message = {
    content: mentions,
    embeds: [{
      title: "【稼働表提出リマインダー🔔】",
      description: `**${reminder.submissionDeadline}** が提出期限です！\n**${reminder.scheduleEndDate}** までの稼働表が未提出のため、ご協力をお願いします。`,
      color: 15158332,
      fields: [{
        name: "未提出者",
        value: nonSubmitters.map(user => `- ${user.name}`).join('\n'),
      }]
    }]
  };
  await axios.post(webhookUrl, message);
}

app.get('/run-reminder', async (req, res) => {
  try {
    const result = await runReminderCheck();
    res.status(200).send(result);
  } catch (error) {
    console.error('リマインダー処理中にエラーが発生しました:', error);
    res.status(500).send('エラーが発生しました。');
  }
});

// ▼▼▼ この部分が抜けていました ▼▼▼
// --- Discordログイン連携機能 ---
app.post('/exchange-discord-code', express.json(), async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).send('Discordの認証コードがありません。');
  }

  try {
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: 'https://todolist-e03b2.web.app/discord-callback.html',
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const accessToken = tokenResponse.data.access_token;
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    const discordUser = userResponse.data;
    const discordId = discordUser.id;
    const discordUsername = discordUser.username;

    const customToken = await admin.auth().createCustomToken(discordId);
    
    res.json({ customToken, discordId, discordUsername });

  } catch (error) {
    console.error('Discord認証の処理中にエラー:', error.response?.data || error.message);
    res.status(500).send('認証に失敗しました。');
  }
});
// ▲▲▲ ここまで ▲▲▲

// STEP 6: サーバーを起動
app.listen(3000, () => {
  console.log('リマインダーBOTサーバーがポート3000で起動しました。');
});
