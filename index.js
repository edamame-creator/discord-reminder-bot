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

    const nonSubmitters = await findNonSubmitters(reminder, reminder.teamId); 

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

// 特定のドキュメントIDを対象にリアクションチェックとリマインドを行う関数
async function checkAndRemind(doc) {
    const check = doc.data();
    const { messageId, postChannelId, reminderChannelId, targetUsers, guildId } = check;
    const botToken = process.env.DISCORD_BOT_TOKEN;

    if (!guildId || !postChannelId || !reminderChannelId) {
        console.error(`ドキュメント ${doc.id} に必要なIDが不足しています。`);
        return;
    }
    
    try {
        const emoji = encodeURIComponent('✅');
        const response = await axios.get(`https://discord.com/api/v10/channels/${postChannelId}/messages/${messageId}/reactions/${emoji}`, {
            headers: { 'Authorization': `Bot ${botToken}` },
            params: { limit: 100 }
        });
        
        const reactedUserIds = response.data.map(user => user.id);
        const nonReactors = targetUsers.filter(targetId => !reactedUserIds.includes(targetId));

        if (nonReactors.length > 0) {
            const reminderMentions = nonReactors.map(userId => `<@${userId}>`).join(' ');
            const originalMessageLink = `https://discord.com/channels/${guildId}/${postChannelId}/${messageId}`;
            const reminderMessage = {
                content: `${reminderMentions}\n\n**【確認リマインダー】**\n下記のメッセージをまだ確認していません。内容を確認の上、リアクションをお願いします。\n${originalMessageLink}`
            };
            await axios.post(`https://discord.com/api/v10/channels/${reminderChannelId}/messages`, reminderMessage, {
                headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' }
            });
            console.log(`[リマインド送信] 未反応者 (${nonReactors.join(', ')}) に送信しました。`);
        } else {
            console.log(`[リマインド不要] メッセージID: ${messageId} は全員反応済みです。`);
        }
    } catch (error) {
        if (error.response && error.response.status === 404) {
            const reminderMentions = targetUsers.map(userId => `<@${userId}>`).join(' ');
            const originalMessageLink = `https://discord.com/channels/${guildId}/${postChannelId}/${messageId}`;
            const reminderMessage = { content: `${reminderMentions}\n\n**【確認リマインダー】**\n${originalMessageLink}` };
            await axios.post(`https://discord.com/api/v10/channels/${reminderChannelId}/messages`, reminderMessage, { headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' } });
            console.log(`[リマインド送信] メッセージID: ${messageId} に誰もリアクションしていなかったため、全員に送信しました。`);
        } else {
            console.error(`[エラー] ID ${messageId} のチェック中にエラー:`, error.message);
        }
    }
}

// 毎日実行される関数は、上記の関数を呼び出すだけにする
async function runReactionCheck() {
    const today = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).split(' ')[0];
    const snapshot = await db.collection('reaction_checks').where('reminderDate', '==', today).where('isReminderSent', '==', false).get();
    if (snapshot.empty) {
        console.log('本日チェックするリアクションはありません。');
        return;
    }
    for (const doc of snapshot.docs) {
        await checkAndRemind(doc); // ★リファクタリングした関数を呼び出し
        await doc.ref.update({ isSent: true }); // 送信済みフラグを立てる
    }
}


async function findNonSubmitters(reminder, teamId) {
    if (!teamId) {
        console.error('findNonSubmittersに関数にteamIdが渡されませんでした。');
        return [];
    }
    const membersRef = db.collection('teams').doc(teamId).collection('members');
    const schedulesRef = db.collection('teams').doc(teamId).collection('schedules'); // ★正しいパス
    
    const membersSnapshot = await membersRef.get();
    const allMembers = membersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    const nonSubmitters = [];
    for (const member of allMembers) {
        let hasSubmitted = false;
        const startDate = new Date(reminder.scheduleStartDate);
        const endDate = new Date(reminder.scheduleEndDate);

        for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
            const dateString = d.toLocaleDateString('sv-SE');
            const scheduleDocRef = schedulesRef.doc(dateString); // ★正しいコレクションを参照
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
    // 環境変数からBotトークンと投稿先チャンネルIDを取得
    const botToken = process.env.DISCORD_BOT_TOKEN;
  
    // 環境変数からではなく、リマインダー情報からチャンネルIDを取得
    const channelId = reminder.channelId; 

    if (!botToken || !channelId) {
        console.error('ボットトークンまたはチャンネルIDが設定されていません。');
        return;
    }

    const mentionsList = nonSubmitters.map(user => 
        user.discordId ? `<@${user.discordId}>` : user.name
    );

    const message = {
        content: mentionsList.join(' '),
        embeds: [{
            title: "【稼働表提出リマインダー🔔】",
            description: `**${reminder.submissionDeadline}** が提出期限です！\n**${reminder.scheduleEndDate}** までの稼働表が未提出のため、ご協力をお願いします。`,
            color: 15158332,
            fields: [{
                name: "未提出者",
                value: mentionsList.map(item => `- ${item}`).join('\n'),
            }]
        }]
    };
    
    try {
        // DiscordのAPIを直接叩いてメッセージを送信
        await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, message, {
            headers: {
                'Authorization': `Bot ${botToken}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        console.error('Discordへの通知送信中にエラーが発生しました:', error.response ? error.response.data : error.message);
    }
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
        // フロントエンドから selectedRoles も受け取る
        const { content, targetUsers = [], targetRoles = [], reminderDate, postChannelId, reminderChannelId, guildId, teamId } = req.body;
        if (!teamId) return res.status(400).send({ success: false, message: 'チームIDが必要です。' });
        const botToken = process.env.DISCORD_BOT_TOKEN;

        let finalTargetUsers = new Set(targetUsers); // 重複を避けるためSetを使用
        let mentions = targetUsers.map(userId => `<@${userId}>`);

        // ロールが選択されている場合の処理
        if (targetRoles.length > 0) {
            // サーバーの全メンバー情報を取得
            const membersResponse = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members`, {
                headers: { 'Authorization': `Bot ${botToken}` },
                params: { limit: 1000 }
            });
            
            // 選択されたロールを持つメンバーを探す
            membersResponse.data.forEach(member => {
                const hasRole = member.roles.some(roleId => targetRoles.includes(roleId));
                if (hasRole && !member.user.bot) {
                    finalTargetUsers.add(member.user.id);
                }
            });
            
            // メンション文字列にロールメンションを追加
            mentions.push(...targetRoles.map(roleId => `<@&${roleId}>`));
        }

        const messageToSend = {
            content: `${mentions.join(' ')}\n\n**【重要なお知らせ】**\n${content}\n\n---\n内容を確認したら、このメッセージに :white_check_mark: のリアクションをお願いします。`,
            allowed_mentions: { parse: ['users', 'roles'] } // ユーザーとロールの両方のメンションを許可
        };

        const response = await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, messageToSend, {
            headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' }
        });
        const messageId = response.data.id;

        // リアクションチェックの記録を作成
        await db.collection('reaction_checks').add({
                messageId: messageId,
                content: content,
                guildId: guildId,
                reminderDate: reminderDate,
                postChannelId: postChannelId,
                reminderChannelId: reminderChannelId,
                targetUsers: Array.from(finalTargetUsers),
                isSent: false,
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
        const { guildId } = req.query; // リクエストからguildIdを取得
        if (!guildId) return res.status(400).json({ message: 'サーバーIDが必要です。' });

        const botToken = process.env.DISCORD_BOT_TOKEN;

        const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members`, {
            headers: { 'Authorization': `Bot ${botToken}` },
            params: { limit: 1000 } // 最大1000人まで取得
        });

       // メンバーリストからボットを除外する .filter() を追加
        const memberList = response.data
            .filter(member => !member.user.bot) 
            .map(member => ({
                id: member.user.id,
                name: member.nick || member.user.username
            })).sort((a, b) => a.name.localeCompare(b.name));

        res.json(memberList);

    } catch (error) {
        console.error('Discordメンバーの取得エラー:', error);
        res.status(500).json({ message: 'メンバーの取得に失敗しました。' });
    }
});

// --- Discordサーバーのチャンネル一覧を取得するエンドポイント ---
app.get('/api/discord/channels', async (req, res) => {
    try {
        const { guildId } = req.query; // リクエストからguildIdを取得
        if (!guildId) {
            return res.status(400).json({ message: 'サーバーIDが必要です。' });
        }
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

app.get('/api/reaction-checks', async (req, res) => {
    try {
        const { guildId, teamId } = req.query; 
        if (!guildId) return res.status(400).json({ message: 'サーバーIDが必要です。' });

        const snapshot = await db.collection('teams').doc(teamId).collection('reaction_checks').where('guildId', '==', guildId).orderBy('createdAt', 'desc').get();
        
        // Firestoreから全メンバーの情報を一度だけ取得
        const membersSnapshot = await db.collection('teams').doc(teamId).collection('members').get();
        const membersMap = new Map(membersSnapshot.docs.map(doc => [doc.data().discordId, doc.data().name]));

        const posts = snapshot.docs.map(doc => {
            const data = doc.data();
            // targetUsersのIDを名前に変換
            const targetUserDetails = data.targetUsers.map(discordId => ({
                id: discordId,
                name: membersMap.get(discordId) || '不明なユーザー'
            }));

            return {
                id: doc.id,
                ...data,
                targetUserDetails: targetUserDetails // ★名前の情報も追加
            };
        });
        res.json(posts);
    } catch (error) {
        console.error('投稿一覧の取得エラー:', error);
        res.status(500).json({ message: '投稿一覧の取得に失敗しました。' });
    }
});

// --- 【機能3用】メッセージを編集するエンドポイント ---
app.patch('/api/edit-message', async (req, res) => {
    try {
        const { postId, messageId, channelId, newContent, teamId } = req.body;
        if (!teamId) return res.status(400).json({ message: 'チームIDが必要です。' });
        
        const botToken = process.env.DISCORD_BOT_TOKEN;

        // 1. Firestoreから元の投稿データを取得する
        const docRef = db.collection('teams').doc(teamId).collection('reaction_checks').doc(postId);
        const doc = await docRef.get();
        if (!doc.exists) {
            return res.status(404).json({ message: '元の投稿データが見つかりません。' });
        }
        const postData = doc.data();
        
        // 2. メンション文字列を再生成
        const mentions = postData.targetUsers.map(userId => `<@${userId}>`).join(' ');
        const fullMessageContent = `${mentions}\n\n**【重要なお知らせ】**\n${newContent}\n\n---\n内容を確認したら、このメッセージに :white_check_mark: のリアクションをお願いします。`;

        // 3. Discord上のメッセージを更新
        await axios.patch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
            content: fullMessageContent
        }, {
            headers: { 'Authorization': `Bot ${botToken}` }
        });

        // 4. Firestoreの本文(content)を更新
        await docRef.update({ content: newContent });

        res.status(200).json({ success: true, message: 'メッセージを更新しました。' });
    } catch (error) {
        console.error('メッセージ編集エラー:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'メッセージの編集に失敗しました。' });
    }
});

// --- 【機能3用】メッセージを削除するエンドポイント ---
app.delete('/api/delete-message', async (req, res) => {
    try {
        const { postId, messageId, channelId, teamId } = req.body;
        const botToken = process.env.DISCORD_BOT_TOKEN;

        // Discord上のメッセージを削除
        await axios.delete(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
            headers: { 'Authorization': `Bot ${botToken}` }
        });

        // Firestoreのドキュメントも削除
        await db.collection('teams').doc(teamId).collection('reaction_checks').doc(postId).delete();
        
        res.status(200).json({ success: true, message: 'メッセージを削除しました。' });
    } catch (error) {
        console.error('メッセージ削除エラー:', error);
        res.status(500).json({ message: 'メッセージの削除に失敗しました。' });
    }
});

// --- ユーザーとBotの共通サーバー一覧を取得するエンドポイント ---
app.get('/api/common-guilds', async (req, res) => {
    try {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ message: 'UIDが必要です。' });

        const botToken = process.env.DISCORD_BOT_TOKEN;

        // 1. Firebase UIDからユーザーのDiscord IDを取得
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists || !userDoc.data().discordId) {
            return res.status(404).json({ message: 'ユーザーに紐づくDiscord IDが見つかりません。' });
        }
        const userDiscordId = userDoc.data().discordId;

        // 2. Botが参加しているサーバー一覧を取得
        const botGuildsResponse = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
            headers: { 'Authorization': `Bot ${botToken}` }
        });
        const botGuilds = botGuildsResponse.data;

        // 3. ユーザーが各サーバーに参加しているか並行してチェック
        const checkPromises = botGuilds.map(async (guild) => {
            try {
                // ユーザーがサーバーのメンバーであるかを確認
                await axios.get(`https://discord.com/api/v10/guilds/${guild.id}/members/${userDiscordId}`, {
                    headers: { 'Authorization': `Bot ${botToken}` }
                });
                return guild; // メンバーであれば、サーバー情報を返す
            } catch (error) {
                // メンバーでない場合(404エラー)、nullを返す
                return null;
            }
        });
        
        // 4. チェックが完了したサーバーのうち、nullでないものだけをリスト化
        const commonGuilds = (await Promise.all(checkPromises)).filter(Boolean);
        
        res.json(commonGuilds);

    } catch (error) {
        console.error('共通サーバーの取得エラー:', error);
        res.status(500).json({ message: '共通サーバーの取得に失敗しました。' });
    }
});

app.post('/api/remind-now', async (req, res) => {
    try {
        const { postId, teamId } = req.body;
        if (!postId) return res.status(400).json({ message: 'postIdが必要です。'});

        const docRef = db.collection('teams').doc(teamId).collection('reaction_checks').doc(postId);
        const doc = await docRef.get();

        if (!doc.exists) return res.status(404).json({ message: '対象の投稿が見つかりません。'});
        
        await checkAndRemind(doc); // ★同じ関数を呼び出す
        
        res.status(200).json({ success: true, message: 'リマインドを送信しました。' });
    } catch (error) {
        console.error('「今すぐリマインド」エラー:', error);
        res.status(500).json({ message: 'リマインドの送信に失敗しました。'});
    }
});

// --- Discordサーバーのロール一覧を取得するエンドポイント ---
app.get('/api/discord/roles', async (req, res) => {
    try {
        const { guildId } = req.query;
        if (!guildId) return res.status(400).json({ message: 'サーバーIDが必要です。' });

        const botToken = process.env.DISCORD_BOT_TOKEN;

        const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
            headers: { 'Authorization': `Bot ${botToken}` }
        });
        
        // @everyoneロールやBotによって管理されているロールを除外し、整形して返す
        const roleList = response.data
            .filter(role => role.name !== '@everyone' && !role.managed)
            .map(role => ({
                id: role.id,
                name: role.name,
                color: role.color // 色情報も渡してあげるとUIで活用できる
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        res.json(roleList);
    } catch (error) {
        console.error('Discordロールの取得エラー:', error);
        res.status(500).json({ message: 'ロールの取得に失敗しました。' });
    }
});

app.post('/api/create-team', async (req, res) => {
    // フロントエンドから送られてきたリクエストから、ユーザーIDと新しいチーム名を取得
    const { uid, teamName } = req.body;
    if (!uid || !teamName) {
        return res.status(400).json({ success: false, error: '不正なリクエストです。' });
    }

    try {
        // 1. `teams`コレクションに新しいチームドキュメントを作成
        const teamRef = await db.collection('teams').add({
            name: teamName,
            ownerId: uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        const teamId = teamRef.id;

        // 2. ユーザーの`users`ドキュメントにある`teams`配列に、新しいチームIDを追加
        const userRef = db.collection('users').doc(uid);
        await userRef.update({
            teams: admin.firestore.FieldValue.arrayUnion(teamId)
        });
        
        // 3. 新しいチームのサブコレクションに、ユーザーを最初のメンバーとして追加
        const userDoc = await userRef.get();
        const userData = userDoc.data();
        
        const memberRef = db.collection('teams').doc(teamId).collection('members').doc(uid);
        await memberRef.set({
            name: userData.name,
            photoURL: userData.photoURL,
            discordId: userData.discordId || null,
            tasks: [],
            order: 0
        });

        res.status(200).json({ success: true, teamId: teamId });

    } catch (error) {
        console.error("チーム作成エラー:", error);
        res.status(500).json({ success: false, error: 'サーバーでエラーが発生しました。' });
    }
});

app.post('/api/join-team', async (req, res) => {
    const { uid, teamId } = req.body;
    if (!uid || !teamId) {
        return res.status(400).json({ success: false, error: '不正なリクエストです。' });
    }

    try {
        const db = admin.firestore();
        const teamRef = db.collection('teams').doc(teamId);
        const teamDoc = await teamRef.get();

        // 1. チームが存在するか確認
        if (!teamDoc.exists) {
            return res.status(404).json({ success: false, error: '指定されたチームが見つかりません。' });
        }

        // 2. ユーザーの`users`ドキュメントにチームIDを追加
        const userRef = db.collection('users').doc(uid);
        await userRef.update({
            teams: admin.firestore.FieldValue.arrayUnion(teamId)
        });

        // 3. チームのサブコレクションにメンバーとして追加
        const userDoc = await userRef.get();
        const userData = userDoc.data();
        const memberRef = teamRef.collection('members').doc(uid);
        await memberRef.set({
            name: userData.name, photoURL: userData.photoURL,
            discordId: userData.discordId || null,
            tasks: [], order: 999 // あとで並び替えられるように大きな値で追加
        });
        
        res.status(200).json({ success: true, teamId: teamId });

    } catch (error) {
        console.error("チーム参加エラー:", error);
        res.status(500).json({ success: false, error: 'サーバーでエラーが発生しました。' });
    }
});

app.listen(3000, () => {
  console.log('リマインダーBOTサーバーがポート3000で起動しました。');
});
