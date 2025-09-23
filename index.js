// --- ライブラリの読み込み ---
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// --- Firebase Admin SDKの初期化 ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- Discord認証情報の環境変数からの取得 ---
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const RENDER_APP_URL = `https://discord-reminder-bot-ixuj.onrender.com`;

// --- Expressアプリの初期化 ---
const app = express();
app.use(cors());

// POSTリクエストのbodyをJSONとして解析するための設定
app.use(express.json());

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
  // --- 新しいリアクション確認処理を呼び出す ---
    console.log('リアクションチェックを開始します...');
    await runReactionCheck();
  return 'リマインダー処理が完了しました。';
}

/**
 * リアクションをチェックして未反応者にリマインドを送信する関数
 */
async function runReactionCheck() {
    const today = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).split(' ')[0];
    const checksRef = db.collection('reaction_checks');
    const snapshot = await checksRef.where('reminderDate', '==', today).where('isReminderSent', '==', false).get();

    if (snapshot.empty) {
        console.log('本日チェックするリアクションはありません。');
        return;
    }

    const botToken = process.env.DISCORD_BOT_TOKEN;

    for (const doc of snapshot.docs) {
        const check = doc.data();
        const { messageId, channelId, targetUsers } = check;
        const guildId = process.env.DISCORD_GUILD_ID; // サーバー(ギルド)IDも環境変数に設定

        try {
            // :white_check_mark: の絵文字をURLエンコードしたもの
            const emoji = encodeURIComponent('✅');
            
            // リアクションしたユーザーのリストを取得
            const response = await axios.get(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${emoji}`, {
                headers: { 'Authorization': `Bot ${botToken}` },
                params: { limit: 100 } // リアクションしたユーザーの上限
            });
            
            const reactedUserIds = response.data.map(user => user.id);

            // 未反応のユーザーを特定
            const nonReactors = targetUsers.filter(targetId => !reactedUserIds.includes(targetId));

            if (nonReactors.length > 0) {
                const reminderMentions = nonReactors.map(userId => `<@${userId}>`).join(' ');
                const originalMessageLink = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
                const reminderMessage = {
                    content: `${reminderMentions}\n\n**【確認リマインダー】**\n下記のメッセージをまだ確認していません。内容を確認の上、リアクションをお願いします。\n${originalMessageLink}`
                };

                // 未反応者にリマインドを送信
                await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, reminderMessage, {
                    headers: {
                        'Authorization': `Bot ${botToken}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`未反応者 (${nonReactors.join(', ')}) にリマインドを送信しました。`);
            } else {
                console.log(`メッセージID: ${messageId} は全員反応済みです。`);
            }

            // リマインダー送信済みフラグを立てる
            await doc.ref.update({ isSent: true });

        } catch (error) {
            // 404エラーはリアクションがまだ誰もしていない場合に発生するため、正常なケースとして扱う
            if (error.response && error.response.status === 404) {
                 const reminderMentions = targetUsers.map(userId => `<@${userId}>`).join(' ');
                 const originalMessageLink = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
                 const reminderMessage = {
                    content: `${reminderMentions}\n\n**【確認リマインダー】**\n下記のメッセージをまだ確認していません。内容を確認の上、リアクションをお願いします。\n${originalMessageLink}`
                };
                 await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, reminderMessage, {
                    headers: {
                        'Authorization': `Bot ${botToken}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`誰もリアクションしていなかったため、全員にリマインドを送信しました。`);
                await doc.ref.update({ isSent: true });

            } else {
               console.error(`メッセージID ${messageId} のチェック中にエラーが発生しました:`, error.response ? error.response.data : error.message);
            }
        }
    }
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


async function sendDiscordNotification(nonSubmitters, reminder) {
  // sendDiscordNotification関数は以前の修正版を流用
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  // 未提出者リストを処理し、メンション（IDがあれば）または名前の文字列を作成
    const mentionsList = nonSubmitters.map(user => 
        user.discordId ? `<@${user.discordId}>` : user.name
    );

    const message = {
        // contentには、スペースで区切ったメンション文字列を設定
        content: mentionsList.join(' '),
        embeds: [{
            title: "【稼働表提出リマインダー🔔】",
            description: `**${reminder.submissionDeadline}** が提出期限です！\n**${reminder.scheduleEndDate}** までの稼働表が未提出のため、ご協力をお願いします。`,
            color: 15158332,
            fields: [{
                name: "未提出者",
                // valueには、改行で区切ったリストを設定
                value: mentionsList.map(item => `- ${item}`).join('\n'),
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

// --- 既読確認メッセージ投稿用のエンドポイント ---
app.post('/post-reaction-check', async (req, res) => {
    try {
        const { content, targetUsers, reminderDate, channelId } = req.body;
        
        // Renderの環境変数からボットトークンとチャンネルIDを取得
        const botToken = process.env.DISCORD_BOT_TOKEN;
        // channelIdはリクエストから受け取るか、環境変数で固定にするか選べます
        const targetChannelId = channelId || process.env.DISCORD_CHANNEL_ID; 
        
        const mentions = targetUsers.map(userId => `<@${userId}>`).join(' ');
        const messageToSend = {
            content: `${mentions}\n\n**【重要なお知らせ】**\n${content}\n\n---\n内容を確認したら、このメッセージに :white_check_mark: のリアクションをお願いします。`
        };

        // Discord APIを直接叩いてメッセージを投稿し、レスポンスからメッセージIDを取得
        const response = await axios.post(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, messageToSend, {
            headers: {
                'Authorization': `Bot ${botToken}`,
                'Content-Type': 'application/json'
            }
        });

        const messageId = response.data.id;

        // Firestoreに管理用のデータを保存
        await db.collection('reaction_checks').add({
            messageId: messageId,
            channelId: targetChannelId,
          content: content,
            targetUsers: targetUsers, // Discord IDの配列
            reminderDate: reminderDate,
            isReminderSent: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).send({ success: true, message: 'メッセージを投稿しました。' });
    } catch (error) {
        console.error('メッセージ投稿エラー:', error.response ? error.response.data : error.message);
        res.status(500).send({ success: false, message: 'エラーが発生しました。' });
    }
});

// --- ステップ 2-3-A: 認証開始用のエンドポイント ---
app.get('/auth/discord', (req, res) => {
  const { uid } = req.query; // フロントエンドからFirebaseのUIDを受け取る

  if (!uid) {
    return res.status(400).send('Firebase UID is required.');
  }

  const redirectUri = `${RENDER_APP_URL}/api/discord/callback`;
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify&state=${uid}`;
  
  res.redirect(discordAuthUrl);
});


// --- ステップ 2-3-B: 認証後のコールバック処理用エンドポイント ---
app.get('/api/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  const firebaseUid = state; // stateに格納しておいたFirebaseのUIDを取得

  if (!code) {
    return res.status(400).send('Discord code is required.');
  }

  try {
    const redirectUri = `${RENDER_APP_URL}/api/discord/callback`;
    
    // 1. 認可コードを使ってアクセストークンを取得
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const accessToken = tokenResponse.data.access_token;

    // 2. アクセストークンを使ってDiscordユーザー情報を取得
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    
    const discordUser = userResponse.data;

    // 3. Firestoreにユーザー情報を保存 (存在しない場合も考慮してset with mergeを使用)
    const userRef = db.collection('users').doc(firebaseUid);
    await userRef.set({
        discordId: discordUser.id,
        discordUsername: `${discordUser.username}#${discordUser.discriminator}`
    }, { merge: true });

    // 4. 連携完了後、フロントエンドのプロフィールページなどにリダイレクト
   res.redirect(`https://todolist-e03b2.web.app/signup.html?discord=success`); // 成功時のリダイレクト先URL

  } catch (error) {
    console.error('Discord OAuth Error:', error.response ? error.response.data : error.message);
    // 失敗時はエラーページなどにリダイレクト
    res.redirect(`https://todolist-e03b2.web.app/signup.html?discord=error`);
  }
});

// --- Discordサーバーのメンバー一覧を取得するエンドポイント ---
app.get('/api/discord/members', async (req, res) => {
    try {
        const guildId = process.env.DISCORD_GUILD_ID;
        const botToken = process.env.DISCORD_BOT_TOKEN;

        const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members`, {
            headers: { 'Authorization': `Bot ${botToken}` },
            params: { limit: 1000 } // 最大1000人まで取得
        });

        // 使いやすいように、名前とIDだけのシンプルなリストに加工して返す
        const memberList = response.data.map(member => ({
            id: member.user.id,
            name: member.nick || member.user.username // ニックネームがあれば優先
        })).sort((a, b) => a.name.localeCompare(b.name)); // 名前順にソート

        res.json(memberList);

    } catch (error) {
        console.error('Discordメンバーの取得エラー:', error);
        res.status(500).json({ message: 'メンバーの取得に失敗しました。' });
    }
});

// --- Discordサーバーのチャンネル一覧を取得するエンドポイント ---
app.get('/api/discord/channels', async (req, res) => {
    try {
        const guildId = process.env.DISCORD_GUILD_ID;
        const botToken = process.env.DISCORD_BOT_TOKEN;

        const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
            headers: { 'Authorization': `Bot ${botToken}` }
        });
        
        // テキストチャンネル(type: 0)のみに絞り込み、名前とIDだけのリストを返す
        const channelList = response.data
            .filter(channel => channel.type === 0)
            .map(channel => ({
                id: channel.id,
                name: channel.name
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        res.json(channelList);

    } catch (error) {
        console.error('Discordチャンネルの取得エラー:', error);
        res.status(500).json({ message: 'チャンネルの取得に失敗しました。' });
    }
});

app.listen(3000, () => {
  console.log('リマインダーBOTサーバーがポート3000で起動しました。');
});
