const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());

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

// ▼▼▼ 修正済みの関数 ▼▼▼
async function findNonSubmitters(reminder) {
  const membersRef = db.collection('members');
  const membersSnapshot = await membersRef.get();
  const allMembers = membersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
  const nonSubmitters = [];

  for (const member of allMembers) {
    let hasSubmitted = false;
    const startDate = new Date(reminder.scheduleStartDate);
    const endDate = new Date(reminder.scheduleEndDate);

    // forループで日付オブジェクトが変更されないようにコピーを作成してループ
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
      // メンション用にDiscord IDも含むオブジェクトを返す
      nonSubmitters.push({ name: member.name, discordId: member.discordId });
    }
  }
  return nonSubmitters;
}
// ▲▲▲ ここまで修正済みの関数 ▲▲▲

async function sendDiscordNotification(nonSubmitters, reminder) {
  // sendDiscordNotification関数は以前の修正版を流用
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



app.listen(3000, () => {
  console.log('リマインダーBOTサーバーがポート3000で起動しました。');
});
