const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    AuditLogEvent,
    PermissionFlagsBits,
    REST,
    Routes,
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');
const http = require('http');

// --- Renderのステータス(In Progress)解決用ダミーWebサーバー ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Discord Bot is running!');
}).listen(PORT, () => {
    console.log(`Renderヘルスチェック用サーバーが Port ${PORT} で起動しました`);
});

// --- クライアント初期化 ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// ID定数定義
const REPORT_CHANNEL_ID = '1517865558136066201';     // 報告・注意ログ用チャンネル
const AD_CHANNEL_ID = '1517868958768693309';         // 宣伝許可チャンネル
const LOG_CHANNEL_ID = '1520424091792838779';        // 退出/キック/BAN/タイムアウト通知用チャンネル
const CONSULT_CHANNEL_ID = '1517760332255461577';    // 相談・チケット用チャンネル
const VERIFY_CHANNEL_ID = '1517692680191344690';     // 認証用チャンネル
const SELF_INTRO_CHANNEL_ID = '1517865558136066201'; // ★自己紹介を投稿するチャンネルID（必要に応じて変更してください）
const BOT_ROLE_ID = '1520422736126804150';            // Bot用初期ロール
const VERIFIED_ROLE_ID = '1517686961765093397';       // 認証完了時ロールID

// メモリデータ保持用
const userMessageTracker = new Map(); 
const userSpamViolations = new Map();
const userAdViolations = new Map();
const consultTargetUsers = new Map(); 
const captchaCodes = new Map(); // 画像認証コード保存用 (userId -> code)

// 4桁のランダム数字を生成
function generateCaptchaCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// メモリリーク防止：古い違反ログや履歴を1時間に1回クリーンアップ
setInterval(() => {
    const now = Date.now();
    for (const [userId, tracker] of userMessageTracker.entries()) {
        tracker.history = tracker.history.filter(msg => now - msg.timestamp < 60000);
        if (tracker.history.length === 0) userMessageTracker.delete(userId);
    }
}, 3600000);

// グローバルエラーハンドラー
process.on('unhandledRejection', (reason) => {
    console.error('未処理のPromise拒否:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('未補獲の例外:', err);
});

// スラッシュコマンド(/setup)の登録
const commands = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('認証・相談・自己紹介パネルを設置します（管理者専用）')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.once('ready', async () => {
    console.log(`${client.user.tag} 起動完了`);

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('スラッシュコマンド (/setup) を登録しました');
    } catch (error) {
        console.error('コマンド登録エラー:', error);
    }
});

// -------------------------------------------------------------
// 1. サーバー参加時
// -------------------------------------------------------------
client.on('guildMemberAdd', async (member) => {
    try {
        if (member.user.bot) {
            try {
                await member.roles.add(BOT_ROLE_ID);
            } catch (err) {
                console.error('Botロール付与権限エラー:', err.message);
            }
        }
    } catch (error) {
        console.error('guildMemberAdd エラー:', error);
    }
});

// -------------------------------------------------------------
// 2. サーバー退出・キック・BAN時
// -------------------------------------------------------------
client.on('guildMemberRemove', async (member) => {
    try {
        const channel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (!channel) return;

        try {
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (member.guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
                const fetchedLogs = await member.guild.fetchAuditLogs({ limit: 1 });
                const firstEntry = fetchedLogs.entries.first();

                if (firstEntry && firstEntry.target?.id === member.id) {
                    if (firstEntry.action === AuditLogEvent.MemberKick && firstEntry.createdTimestamp > Date.now() - 5000) {
                        return await channel.send(`${member.user.username} さんがキックされました。`);
                    }
                    if (firstEntry.action === AuditLogEvent.MemberBanAdd && firstEntry.createdTimestamp > Date.now() - 5000) {
                        return await channel.send(`${member.user.username} さんがBANされました。`);
                    }
                }
            }
        } catch (auditError) {
            console.error('監査ログ取得スキップ:', auditError.message);
        }

        await channel.send(`${member.user.username} さんがサーバーを退出しました。`);
    } catch (error) {
        console.error('guildMemberRemove エラー:', error);
    }
});

// -------------------------------------------------------------
// 3. タイムアウト検知
// -------------------------------------------------------------
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        const channel = newMember.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (!channel) return;

        const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
        const newTimeout = newMember.communicationDisabledUntilTimestamp;

        if (!oldTimeout && newTimeout && newTimeout > Date.now()) {
            const durationMinutes = Math.ceil((newTimeout - Date.now()) / (1000 * 60));
            await channel.send(`@${newMember.user.username}さんが${durationMinutes}分タイムアウトされました`);
        }
    } catch (error) {
        console.error('guildMemberUpdate エラー:', error);
    }
});

// -------------------------------------------------------------
// 4. インタラクション処理 (認証・チケット・自己紹介・モーダル・返信機能・/setup)
// -------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
    try {
        // --- A. スラッシュコマンド (/setup) ---
        const isSlashCommand = (typeof interaction.isChatInput === 'function' && interaction.isChatInput()) || 
                               (typeof interaction.isCommand === 'function' && interaction.isCommand());

        if (isSlashCommand && interaction.commandName === 'setup') {
            if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
                return await interaction.reply({ content: '管理者権限が必要です。', flags: MessageFlags.Ephemeral });
            }

            // 認証パネルの送信
            const verifyChannel = interaction.guild.channels.cache.get(VERIFY_CHANNEL_ID) || interaction.channel;
            const verifyEmbed = new EmbedBuilder()
                .setTitle('🛡️ サーバー認証')
                .setDescription('下のボタンを押して画像認証を完了させてください。')
                .setColor(0x2B2D31);

            const verifyRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('verify_button')
                    .setLabel('🔓 認証を開始する')
                    .setStyle(ButtonStyle.Primary)
            );
            await verifyChannel.send({ embeds: [verifyEmbed], components: [verifyRow] });

            // 相談・チケットパネルの送信
            const consultChannel = interaction.guild.channels.cache.get(CONSULT_CHANNEL_ID);
            if (consultChannel) {
                const consultEmbed = new EmbedBuilder()
                    .setTitle('📝 相談・サポート窓口')
                    .setDescription('カテゴリーを選択し、「チケットを発行する」ボタンを押してフォームを入力してください。')
                    .setColor(0x0099FF);

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('consult_category_select')
                    .setPlaceholder('カテゴリーを選択してください')
                    .addOptions([
                        { label: '質問・相談', value: '質問・相談', description: '一般的な相談や質問はこちら' },
                        { label: '通報', value: '通報', description: '規約違反者や問題行動の報告' },
                        { label: '提案', value: '提案', description: 'サーバーへの改善アイデアや提案' },
                        { label: '不具合報告', value: '不具合報告', description: '不具合報告はこちら' }
                    ]);

                const ticketButton = new ButtonBuilder()
                    .setCustomId('open_ticket_modal_btn')
                    .setLabel('チケットを発行する')
                    .setStyle(ButtonStyle.Primary);

                const row1 = new ActionRowBuilder().addComponents(selectMenu);
                const row2 = new ActionRowBuilder().addComponents(ticketButton);

                await consultChannel.send({ embeds: [consultEmbed], components: [row1, row2] });
            }

            // ★ 追加：自己紹介パネルの送信
            const selfIntroChannel = interaction.guild.channels.cache.get(SELF_INTRO_CHANNEL_ID) || interaction.channel;
            const selfIntroEmbed = new EmbedBuilder()
                .setTitle('👋 自己紹介パネル')
                .setDescription('下のボタンを押すと入力フォームが開きます。入力した自己紹介は専用チャンネルに自動投稿されます。')
                .setColor(0x57F287);

            const selfIntroRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('open_self_intro_modal_btn')
                    .setLabel('✏️ 自己紹介を書く')
                    .setStyle(ButtonStyle.Success)
            );

            await selfIntroChannel.send({ embeds: [selfIntroEmbed], components: [selfIntroRow] });

            await interaction.reply({ content: '✅ 各パネル（認証・相談・自己紹介）の設置が完了しました。', flags: MessageFlags.Ephemeral });
            return;
        }

        // --- B. ボタンの処理 ---
        if (interaction.isButton()) {
            // 認証開始ボタンが押された時
            if (interaction.customId === 'verify_button') {
                const member = interaction.member;

                if (member.roles.cache.has(VERIFIED_ROLE_ID)) {
                    return await interaction.reply({ content: '✅ すでに認証済みです！', flags: MessageFlags.Ephemeral });
                }

                const code = generateCaptchaCode();
                captchaCodes.set(interaction.user.id, code);

                const imageUrl = `https://dummyimage.com/300x100/2f3136/00ff99.png&text=${code}`;

                const captchaEmbed = new EmbedBuilder()
                    .setTitle('📷 画像認証')
                    .setDescription('以下の画像に表示されている **4桁の数字** を「数字を入力する」ボタンから入力してください。')
                    .setImage(imageUrl)
                    .setColor(0x00FF99);

                const inputButton = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('submit_captcha_code_btn')
                        .setLabel('数字を入力する')
                        .setStyle(ButtonStyle.Success)
                );

                await interaction.reply({ 
                    embeds: [captchaEmbed], 
                    components: [inputButton], 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // 画像認証の入力用ボタン
            if (interaction.customId === 'submit_captcha_code_btn') {
                const modal = new ModalBuilder()
                    .setCustomId('captcha_modal')
                    .setTitle('画像認証コード入力');

                const captchaInput = new TextInputBuilder()
                    .setCustomId('captcha_input')
                    .setLabel('画像に書かれていた4桁の数字')
                    .setPlaceholder('例: 1234')
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(4)
                    .setMaxLength(4)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(captchaInput));
                await interaction.showModal(modal);
                return;
            }

            // チケット発行ボタン
            if (interaction.customId === 'open_ticket_modal_btn') {
                const modal = new ModalBuilder()
                    .setCustomId('consult_modal')
                    .setTitle('相談・サポート入力');

                const input = new TextInputBuilder()
                    .setCustomId('consult_content')
                    .setLabel('相談・提案・報告内容を入力してください')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await interaction.showModal(modal);
                return;
            }

            // ★ 追加：「自己紹介を書く」ボタンが押された時
            if (interaction.customId === 'open_self_intro_modal_btn') {
                const modal = new ModalBuilder()
                    .setCustomId('self_intro_modal')
                    .setTitle('自己紹介入力');

                const nameInput = new TextInputBuilder()
                    .setCustomId('intro_name')
                    .setLabel('お名前・呼び方')
                    .setPlaceholder('例: たろう')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const hobbyInput = new TextInputBuilder()
                    .setCustomId('intro_hobby')
                    .setLabel('趣味・好きなゲームなど')
                    .setPlaceholder('例: Discord Bot作成、APEX')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false);

                const bioInput = new TextInputBuilder()
                    .setCustomId('intro_bio')
                    .setLabel('一言メッセージ')
                    .setPlaceholder('例: よろしくお願いします！')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(nameInput),
                    new ActionRowBuilder().addComponents(hobbyInput),
                    new ActionRowBuilder().addComponents(bioInput)
                );

                await interaction.showModal(modal);
                return;
            }

            // 管理者用「返信」ボタン
            if (interaction.customId.startsWith('reply_consult_')) {
                const targetUserId = interaction.customId.replace('reply_consult_', '');
                consultTargetUsers.set(interaction.user.id, targetUserId);

                const modal = new ModalBuilder()
                    .setCustomId('reply_modal')
                    .setTitle('相談者へ返信');

                const replyInput = new TextInputBuilder()
                    .setCustomId('reply_text')
                    .setLabel('返信する内容を入力してください')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(replyInput));
                await interaction.showModal(modal);
                return;
            }
        }

        // --- C. セレクトメニューの処理 ---
        const isSelectMenu = (typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu()) ||
                             (typeof interaction.isSelectMenu === 'function' && interaction.isSelectMenu());

        if (isSelectMenu && interaction.customId === 'consult_category_select') {
            const selectedCategory = interaction.values[0];
            await interaction.reply({ 
                content: `カテゴリー「**${selectedCategory}**」を選択しました。下の「チケットを発行する」ボタンを押して内容を入力してください。`, 
                flags: MessageFlags.Ephemeral 
            });
            return;
        }

        // --- D. モーダル送信の処理 ---
        if (interaction.isModalSubmit()) {
            // キャプチャ画像認証の解答入力
            if (interaction.customId === 'captcha_modal') {
                const inputCode = interaction.fields.getTextInputValue('captcha_input');
                const correctCode = captchaCodes.get(interaction.user.id);

                if (!correctCode || inputCode !== correctCode) {
                    captchaCodes.delete(interaction.user.id);
                    return await interaction.reply({ content: '❌ 数字が違います。もう一度「🔓 認証を開始する」ボタンを押してやり直してください。', flags: MessageFlags.Ephemeral });
                }

                captchaCodes.delete(interaction.user.id);
                const role = interaction.guild.roles.cache.get(VERIFIED_ROLE_ID);

                if (role) {
                    await interaction.member.roles.add(role);
                }

                if (interaction.message) {
                    await interaction.message.react('📝').catch(() => {});
                }

                return await interaction.reply({ content: '🎉 画像認証が完了し、ロールを付与しました！サーバーをお楽しみください。', flags: MessageFlags.Ephemeral });
            }

            // ユーザーからの相談送信モーダル
            if (interaction.customId === 'consult_modal') {
                const consultContent = interaction.fields.getTextInputValue('consult_content');
                const consultChannel = interaction.guild.channels.cache.get(CONSULT_CHANNEL_ID);

                if (consultChannel) {
                    const embed = new EmbedBuilder()
                        .setTitle('📩 新しい相談・お問い合わせ')
                        .setColor(0x00A2E8)
                        .addFields(
                            { name: '送信者', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                            { name: '内容', value: consultContent }
                        )
                        .setTimestamp();

                    const replyBtn = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`reply_consult_${interaction.user.id}`)
                            .setLabel('返信')
                            .setStyle(ButtonStyle.Primary)
                    );

                    await consultChannel.send({ embeds: [embed], components: [replyBtn] });
                }

                await interaction.reply({ content: '✅ 内容を送信しました。対応をお待ちください。', flags: MessageFlags.Ephemeral });
                return;
            }

            // ★ 追加：自己紹介モーダルの送信処理
            if (interaction.customId === 'self_intro_modal') {
                const name = interaction.fields.getTextInputValue('intro_name');
                const hobby = interaction.fields.getTextInputValue('intro_hobby') || 'なし';
                const bio = interaction.fields.getTextInputValue('intro_bio');

                const selfIntroChannel = interaction.guild.channels.cache.get(SELF_INTRO_CHANNEL_ID);

                const introEmbed = new EmbedBuilder()
                    .setTitle(`📝 自己紹介 - ${name}`)
                    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setColor(0x57F287)
                    .addFields(
                        { name: '👤 名前', value: name, inline: true },
                        { name: '🎮 趣味・好きなこと', value: hobby, inline: true },
                        { name: '💬 一言メッセージ', value: bio }
                    )
                    .setFooter({ text: `User ID: ${interaction.user.id}` })
                    .setTimestamp();

                if (selfIntroChannel) {
                    await selfIntroChannel.send({ embeds: [introEmbed] });
                    await interaction.reply({ content: '✅ 自己紹介カードを投稿しました！', flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: '❌ 自己紹介投稿用チャンネルが見つかりませんでした。', flags: MessageFlags.Ephemeral });
                }
                return;
            }

            // 管理者からの返信送信モーダル
            if (interaction.customId === 'reply_modal') {
                const replyText = interaction.fields.getTextInputValue('reply_text');
                const targetUserId = consultTargetUsers.get(interaction.user.id);

                if (!targetUserId) {
                    return await interaction.reply({ content: '❌ 返信対象のユーザーが見つかりませんでした。', flags: MessageFlags.Ephemeral });
                }

                try {
                    const targetUser = await client.users.fetch(targetUserId);
                    await targetUser.send(`📩 **運営からの返信**:\n${replyText}`);
                    await interaction.reply({ content: `✅ <@${targetUserId}> さんへDMで返信を送信しました。`, flags: MessageFlags.Ephemeral });
                } catch (e) {
                    await interaction.reply({ content: '❌ DMの送信に失敗しました。', flags: MessageFlags.Ephemeral });
                } finally {
                    consultTargetUsers.delete(interaction.user.id);
                }
                return;
            }
        }
    } catch (error) {
        console.error('インタラクション処理エラー:', error);
        const errMsg = { content: '❌ 処理中にエラーが発生しました。', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errMsg).catch(() => {});
        } else {
            await interaction.reply(errMsg).catch(() => {});
        }
    }
});

// -------------------------------------------------------------
// 5. メッセージ受信時の処理 (通報・相談コマンド & スパム・宣伝判定)
// -------------------------------------------------------------
client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot || !message.guild) return;

        const userId = message.author.id;
        const username = message.author.username;
        const content = message.content || '';
        const reportChannel = message.guild.channels.cache.get(REPORT_CHANNEL_ID);

        const prefixes = ['!通報', '!提案', '!質問', '!不具合', '!相談'];
        const matchedPrefix = prefixes.find(p => content.startsWith(p));

        if (matchedPrefix) {
            const bodyText = content.slice(matchedPrefix.length).trim();
            if (!bodyText) {
                await message.reply(`⚠️ ${matchedPrefix} の後に内容を入力してください。`).catch(() => {});
                return;
            }

            if (reportChannel) {
                const embed = new EmbedBuilder()
                    .setTitle(`📩 新しい ${matchedPrefix.replace('!', '')} メッセージ`)
                    .setColor(matchedPrefix === '!通報' ? 0xFF0000 : 0x00FF99)
                    .addFields(
                        { name: '送信者', value: `<@${userId}> (${message.author.tag})`, inline: true },
                        { name: '送信場所', value: `<#${message.channel.id}>`, inline: true },
                        { name: '内容', value: bodyText }
                    )
                    .setTimestamp();

                await reportChannel.send({ embeds: [embed] }).catch(() => {});
            }

            try { if (message.deletable) await message.delete(); } catch (_) {}
            await message.channel.send(`✅ <@${userId}> さんのメッセージを送信しました！`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
            return;
        }

        // --- A. スパム検知 ---
        if (content.trim() !== '') {
            const now = Date.now();
            let userTracker = userMessageTracker.get(userId) || { history: [] };

            userTracker.history = userTracker.history.filter(m => now - m.timestamp < 60000);
            userTracker.history.push({ content: content, timestamp: now });
            userMessageTracker.set(userId, userTracker);

            const sameMessageCount = userTracker.history.filter(m => m.content === content).length;

            if (sameMessageCount >= 15) {
                userMessageTracker.set(userId, { history: [] });

                try {
                    const fetchedMessages = await message.channel.messages.fetch({ limit: 50 });
                    const userSpamMessages = fetchedMessages.filter(m => m.author.id === userId && m.content === content);
                    await message.channel.bulkDelete(userSpamMessages).catch(() => {
                        if (message.deletable) message.delete().catch(() => {});
                    });
                } catch (_) {
                    if (message.deletable) await message.delete().catch(() => {});
                }

                const violations = (userSpamViolations.get(userId) || 0) + 1;
                userSpamViolations.set(userId, violations);

                if (violations === 1) {
                    await message.author.send('⚠️ **注意**: 1分間に同じ発言を15回行ったためメッセージが削除されました。もう一度行うと1日間タイムアウトになります。').catch(() => {});
                    if (reportChannel) {
                        await reportChannel.send(`@${username}さんが、${content}という発言を15回発言したので、メッセージを削除しました。`).catch(() => {});
                    }
                } else if (violations >= 2) {
                    try {
                        if (message.member?.moderatable) {
                            await message.member.timeout(24 * 60 * 60 * 1000, 'スパム連投2回目');
                        }
                        await message.author.send('⚠️ 1分間に同じ発言を15回以上行うスパム行為が2回続いたため、1日間タイムアウトされました。').catch(() => {});
                    } catch (e) { console.error('タイムアウト失敗:', e.message); }

                    if (reportChannel) {
                        await reportChannel.send(`(2回目)@${username}さんが2回めの${content}という発言を15回発言したので、削除と1日タイムアウトされました。`).catch(() => {});
                    }
                    userSpamViolations.set(userId, 0);
                }
                return;
            }
        }

        // --- B. サーバー宣伝検知 ---
        const isDiscordInvite = /(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9]+/i.test(content);
        if (isDiscordInvite && message.channel.id !== AD_CHANNEL_ID) {
            try { if (message.deletable) await message.delete(); } catch (_) {}

            const violations = (userAdViolations.get(userId) || 0) + 1;
            userAdViolations.set(userId, violations);

            const channelName = message.channel.name;

            if (violations === 1) {
                await message.author.send(`⚠️ **注意**: 許可されていないチャンネル（#${channelName}）でサーバーの宣伝を行ったためメッセージが削除されました。もう一度行うと1日間タイムアウトになります。`).catch(() => {});
                if (reportChannel) {
                    await reportChannel.send(`@${username}さんが宣伝以外のチャンネル(${channelName})でサーバーの宣伝をしたため、削除されました。`).catch(() => {});
                }
            } else if (violations >= 2) {
                try {
                    if (message.member?.moderatable) {
                        await message.member.timeout(24 * 60 * 60 * 1000, '他サーバー宣伝2回目');
                    }
                    await message.author.send('⚠️ 許可されていない場所での宣伝が2回続いたため、1日間タイムアウトされました。').catch(() => {});
                } catch (e) { console.error('タイムアウト失敗:', e.message); }

                if (reportChannel) {
                    await reportChannel.send(`(2回め)@${username}さんが宣伝以外のチャンネル(${channelName})で2回目のサーバー宣伝をしたため、削除と1日間タイムアウトしました。`).catch(() => {});
                }
                userAdViolations.set(userId, 0);
            }
            return;
        }

    } catch (error) {
        console.error('messageCreate エラー:', error);
    }
});

client.login(process.env.DISCORD_TOKEN);
