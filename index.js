// STEP 1: 必要なライブラリを読み込む
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors'); 

// STEP 2: Firebaseの初期設定
// ReplitのSecretsに保存した情報を使ってFirebaseを初期化
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// STEP 3: Expressサーバーの準備
const app = express();
app.use(cors()); 

// STEP 4: メインの処理を行う関数
async function runReminderCheck() {
  console.log('リマインダーチェックを開始します...');

 // 日本時間（JST）で今日の日付をYYYY-MM-DD形式で取得
const jstDateString = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
const today = jstDateString.split(' ')[0];

  // Firestoreから今日がリマインド日で、まだ未送信のリマインダーを探す
  const remindersRef = db.collection('reminders');
  const snapshot = await remindersRef.where('reminderDate', '==', today).where('isSent', '==', false).get();

  if (snapshot.empty) {
    console.log('本日実行するリマインダーはありません。');
    return '本日実行するリマインダーはありませんでした。';
  }

  // 見つかった各リマインダーに対して処理を実行
  for (const doc of snapshot.docs) {
    const reminder = doc.data();
    console.log(`リマインダー「${reminder.submissionDeadline}」の処理を開始します。`);

    // 未提出者を探す
    const nonSubmitters = await findNonSubmitters(reminder);

    // 未提出者がいればDiscordに通知
    if (nonSubmitters.length > 0) {
      await sendDiscordNotification(nonSubmitters, reminder);
      console.log('未提出者に通知を送信しました。');
    } else {
      console.log('全員提出済みです。');
    }

    // 送信済みフラグを更新
    await doc.ref.update({ isSent: true });
  }

  return 'リマインダー処理が完了しました。';
}

// 未提出者を探すヘルパー関数
async function findNonSubmitters(reminder) {
  const membersRef = db.collection('members');
  const membersSnapshot = await membersRef.get();
  const allMembers = membersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
  const nonSubmitters = [];

  // 全メンバーをループして提出状況をチェック
  for (const member of allMembers) {
    let hasSubmitted = false;
    // チェックすべき期間の日付をループ
    const startDate = new Date(reminder.scheduleStartDate);
    const endDate = new Date(reminder.scheduleEndDate);

    for (let d = startDate; d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateString = d.toLocaleDateString('sv-SE');
      const scheduleDocRef = db.collection('schedules').doc(dateString);
      const scheduleDoc = await scheduleDocRef.get();

      if (scheduleDoc.exists) {
        const data = scheduleDoc.data();
        const hasAvailability = data.availability?.[member.id]?.length > 0;
        const isUnavailable = data.unavailable?.[member.id] === true;
        
        // どちらかの入力があれば提出済みとみなす
        if (hasAvailability || isUnavailable) {
          hasSubmitted = true;
          break; // このメンバーのチェックは完了
        }
      }
    }
    
    if (!hasSubmitted) {
      nonSubmitters.push(member.name); // 未提出者リストに名前を追加
    }
  }
  return nonSubmitters;
}

// Discordに通知を送るヘルパー関数
async function sendDiscordNotification(nonSubmitters, reminder) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const message = {
    content: `【稼働表リマインダー🔔】\n**${reminder.submissionDeadline}** 提出期限の稼働表が未提出の方がいます！\n\n**未提出者:**\n- ${nonSubmitters.join('\n- ')}\n\n提出のご協力をお願いします。`
  };
  await axios.post(webhookUrl, message);
}


// STEP 5: 外部から呼び出されるための窓口（エンドポイント）を作成
app.get('/run-reminder', async (req, res) => {
  try {
    const result = await runReminderCheck();
    res.status(200).send(result);
  } catch (error) {
    console.error('リマインダー処理中にエラーが発生しました:', error);
    res.status(500).send('エラーが発生しました。');
  }
});

// Discordの認証コードをFirebaseのカスタムトークンに交換するためのエンドポイント
app.post('/exchange-discord-code', express.json(), async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).send('Discordの認証コードがありません。');
  }

  try {
    // 1. Discordに認証コードを送り、アクセストークンを取得
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

    // 2. アクセストークンを使い、Discordユーザーの情報を取得
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    const discordUser = userResponse.data;
    const discordId = discordUser.id;

    // 3. 取得したDiscord IDを元に、Firebaseのカスタムトークンを生成
    const customToken = await admin.auth().createCustomToken(discordId);

    // 4. フロントエンドにカスタムトークンとDiscord IDを返す
    res.json({ customToken, discordId });

  } catch (error) {
    console.error('Discord認証の処理中にエラー:', error.response?.data || error.message);
    res.status(500).send('認証に失敗しました。');
  }
});

// STEP 6: サーバーを起動
app.listen(3000, () => {
  console.log('リマインダーBOTサーバーがポート3000で起動しました。');
});
