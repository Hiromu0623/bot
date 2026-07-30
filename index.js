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
SlashCommandBuilder
} = require('discord.js');
const express = require('express');
// --- Render用Webサーバー構築(In Progress問題対策) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => {
res.send('Bot is running successfully!');
});
app.listen(PORT, () => {
console.log(`[Render WebServer] Listening on port ${PORT}`);
});
// --- Bot クライアント初期化 ---
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
const REPORT_CHANNEL_ID = '1517865558136066201'; // 報告・注意ログ用チャンネル
const AD_CHANNEL_ID = '1517868958768693309'; // 宣伝許可チャンネル
const LOG_CHANNEL_ID = '1520424091792838779'; // 退出/キック/BAN/タイムアウト通知用チャンネル
const CONSULT_CHANNEL_ID = '1517760332255461577'; // 相談・チケット用チャンネル
const BOT_ROLE_ID = '1520422736126804150'; // Bot用初期ロール
const VERIFIED_ROLE_ID = '1517868958768693309'; // 認証完了時ロールID
// メモリデータ保持用
const userMessageTracker = new Map(); // スパム監視用 { history: [{ content, timestamp }] }
const userSpamViolations = new Map();
const userAdViolations = new Map();
const consultTargetUsers = new Map(); // 返信ボタンを押した管理者の操作メモリ
// メモリリーク防止:古い履歴を定期削除
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
// スラッシュコマンド(/setup)の登録定義
const commands = [
new SlashCommandBuilder()
.setName('setup')
.setDescription('認証パネルおよび相談パネルを設置します(管理者専用)')
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
console.log('スラッシュコマンド (/setup) を正常登録しました');
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
// 2. サーバー退出・キック・BAN時 (チャンネル: 1520424091792838779)
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
if (firstEntry.action === AuditLogEvent.MemberKick &&
firstEntry.createdTimestamp > Date.now() - 5000) {
return await channel.send(`${member.user.username} さんがキックされました。
`);
}
if (firstEntry.action === AuditLogEvent.MemberBanAdd &&
firstEntry.createdTimestamp > Date.now() - 5000) {
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
// 3. タイムアウト検知 (チャンネル: 1520424091792838779)
// -------------------------------------------------------------
client.on('guildMemberUpdate', async (oldMember, newMember) => {
try {
const channel = newMember.guild.channels.cache.get(LOG_CHANNEL_ID);
if (!channel) return;
const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
const newTimeout = newMember.communicationDisabledUntilTimestamp;
if (!oldTimeout && newTimeout && newTimeout > Date.now()) {
const durationMinutes = Math.ceil((newTimeout - Date.now()) / (1000 * 60));
await channel.send(`@${newMember.user.username}さんが${durationMinutes}分タイムアウトさ

れました`);
}
} catch (error) {
console.error('guildMemberUpdate エラー:', error);
}
});
// -------------------------------------------------------------
// 4. インタラクション処理 (認証・チケット・モーダル・返信・/setup)
// -------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
try {
// --- A. スラッシュコマンド (/setup) ---
if (interaction.isChatInput() && interaction.commandName === 'setup') {
if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
return await interaction.reply({ content: '管理者権限が必要です。', ephemeral:
true });
}
// 認証パネルの送信
const verifyEmbed = new EmbedBuilder()
.setTitle(' サーバー認証')
.setDescription('下の「認証する」ボタンを押してサーバーへのアクセス権を取得してください。')
.setColor(0x00FF99);
const verifyRow = new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId('verify_button')
.setLabel('認証する')
.setStyle(ButtonStyle.Success)
);
await interaction.channel.send({ embeds: [verifyEmbed], components: [verifyRow] });
// 相談・チケットパネルの送信 (1517760332255461577 用)
const consultChannel = interaction.guild.channels.cache.get(CONSULT_CHANNEL_ID);
if (consultChannel) {
const consultEmbed = new EmbedBuilder()
.setTitle(' 相談・サポート窓口')
.setDescription('カテゴリーを選択し、「チケットを発行する」ボタンを押してフォームを入力
してください。')
.setColor(0x0099FF);
const selectMenu = new StringSelectMenuBuilder()
.setCustomId('consult_category_select')
.setPlaceholder('カテゴリーを選択してください')
.addOptions([
{ label: '質問・相談', value: '質問・相談', description: '一般的な相談や質問は
こちら' },
{ label: '通報', value: '通報', description: '規約違反者や問題行動の報告' },
{ label: '提案', value: '提案', description: 'サーバーへの改善アイデアや提
案' },
{ label: '不具合報告', value: '不具合報告', description: 'Botやサーバーの不具
合報告' }
]);
const ticketButton = new ButtonBuilder()
.setCustomId('open_ticket_modal_btn')
.setLabel('チケットを発行する')
.setStyle(ButtonStyle.Primary);

const row1 = new ActionRowBuilder().addComponents(selectMenu);
const row2 = new ActionRowBuilder().addComponents(ticketButton);
await consultChannel.send({ embeds: [consultEmbed], components: [row1, row2] });
}
await interaction.reply({ content: ' 各パネルの設置が完了しました。', ephemeral:
true });
return;
}
// --- B. ボタン処理 ---
if (interaction.isButton()) {
// 認証ボタン
if (interaction.customId === 'verify_button') {
const member = interaction.member;
const role = interaction.guild.roles.cache.get(VERIFIED_ROLE_ID);
if (role) {
if (member.roles.cache.has(role.id)) {
return await interaction.reply({ content: ' すでに認証済みです!',
ephemeral: true });
}
await member.roles.add(role);
}
// 認証時に :pencil: ( ) のリアクションを付ける
if (interaction.message) {
await interaction.message.react(' ').catch(() => {});
}
return await interaction.reply({ content: ' 認証が完了しました!サーバーをお楽しみく
ださい。', ephemeral: true });
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
const firstActionRow = new ActionRowBuilder().addComponents(input);
modal.addComponents(firstActionRow);
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
const row = new ActionRowBuilder().addComponents(replyInput);
modal.addComponents(row);
await interaction.showModal(modal);
return;
}
}
// --- C. セレクトメニュー(カテゴリー選択) ---
if (interaction.isStringSelectMenu() && interaction.customId ===
'consult_category_select') {
const selectedCategory = interaction.values[0];
await interaction.reply({
content: `カテゴリー「**${selectedCategory}**」を選択しました。下の「チケットを発行する」
ボタンを押して内容を入力してください。`,
ephemeral: true
});
return;
}
// --- D. モーダル送信処理 ---
if (interaction.isModalSubmit()) {
// ユーザー相談モーダル
if (interaction.customId === 'consult_modal') {
const consultContent = interaction.fields.getTextInputValue('consult_content');
const consultChannel = interaction.guild.channels.cache.get(CONSULT_CHANNEL_ID);
if (consultChannel) {
const embed = new EmbedBuilder()
.setTitle(' 新しい相談・お問い合わせ')
.setColor(0x00A2E8)
.addFields(
{ name: '送信者', value: `<@${interaction.user.id}> ($
{interaction.user.tag})`, inline: true },
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
await interaction.reply({ content: ' 内容を送信しました。対応をお待ちください。',
ephemeral: true });
return;
}
// 管理者返信モーダル
if (interaction.customId === 'reply_modal') {

const replyText = interaction.fields.getTextInputValue('reply_text');
const targetUserId = consultTargetUsers.get(interaction.user.id);
if (!targetUserId) {
return await interaction.reply({ content: ' 返信対象のユーザーが見つかりませんで
した。', ephemeral: true });
}
try {
const targetUser = await client.users.fetch(targetUserId);
await targetUser.send(` **運営からの返信**:
${replyText}`);
await interaction.reply({ content: ` <@${targetUserId}> さんへDMで返信を送信
しました。`, ephemeral: true });
} catch (e) {
await interaction.reply({ content: ' DMの送信に失敗しました。(DM非公開設定の可
能性があります)', ephemeral: true });
} finally {
consultTargetUsers.delete(interaction.user.id);
}
return;
}
}
} catch (error) {
console.error('インタラクション処理エラー:', error);
const errMsg = { content: ' 処理中にエラーが発生しました。', ephemeral: true };
if (interaction.replied || interaction.deferred) {
await interaction.followUp(errMsg).catch(() => {});
} else {
await interaction.reply(errMsg).catch(() => {});
}
}
});
// -------------------------------------------------------------
// 5. メッセージ受信時の処理 (コマンド・スパム検知・宣伝検知)
// -------------------------------------------------------------
client.on('messageCreate', async (message) => {
try {
if (message.author.bot || !message.guild) return;
const userId = message.author.id;
const username = message.author.username;
const content = message.content || '';
const reportChannel = message.guild.channels.cache.get(REPORT_CHANNEL_ID);
// --- 認証パネル単体設置 (!認証パネル) ---
if (content === '!認証パネル' &&
message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
const embed = new EmbedBuilder()
.setTitle(' サーバー認証')
.setDescription('下の「認証する」ボタンを押してサーバーへのアクセス権を取得してください。')
.setColor(0x00FF99);
const row = new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId('verify_button')
.setLabel('認証する')
.setStyle(ButtonStyle.Success)
);

await message.channel.send({ embeds: [embed], components: [row] });
try { if (message.deletable) await message.delete(); } catch (_) {}
return;
}
// --- テキストコマンド (!通報, !相談 等) ---
const prefixes = ['!通報', '!提案', '!質問', '!不具合', '!相談'];
const matchedPrefix = prefixes.find(p => content.startsWith(p));
if (matchedPrefix) {
const bodyText = content.slice(matchedPrefix.length).trim();
if (!bodyText) {
await message.reply(` ${matchedPrefix} の後に内容を入力してください。`).catch(() =>
{});
return;
}
if (reportChannel) {
const embed = new EmbedBuilder()
.setTitle(` 新しい ${matchedPrefix.replace('!', '')} メッセージ`)
.setColor(matchedPrefix === '!通報' ? 0xFF0000 : 0x00FF99)
.addFields(
{ name: '送信者', value: `<@${userId}> (${message.author.tag})`, inline:
true },
{ name: '送信場所', value: `<#${message.channel.id}>`, inline: true },
{ name: '内容', value: bodyText }
)
.setTimestamp();
await reportChannel.send({ embeds: [embed] }).catch(() => {});
}
try { if (message.deletable) await message.delete(); } catch (_) {}
await message.channel.send(` <@${userId}> さんのメッセージを送信しました!`).then(m =>
setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
return;
}
// --- A. スパム検知(1分間に15回同じ発言) ---
if (content.trim() !== '') {
const now = Date.now();
let userTracker = userMessageTracker.get(userId) || { history: [] };
userTracker.history = userTracker.history.filter(m => now - m.timestamp < 60000);
userTracker.history.push({ content: content, timestamp: now });
userMessageTracker.set(userId, userTracker);
const sameMessageCount = userTracker.history.filter(m => m.content ===
content).length;
if (sameMessageCount >= 15) {
userMessageTracker.set(userId, { history: [] });
try {
const fetchedMessages = await message.channel.messages.fetch({ limit: 50 });
const userSpamMessages = fetchedMessages.filter(m => m.author.id === userId
&& m.content === content);
await message.channel.bulkDelete(userSpamMessages).catch(() => {
if (message.deletable) message.delete().catch(() => {});
});
} catch (_) {
if (message.deletable) await message.delete().catch(() => {});

}
const violations = (userSpamViolations.get(userId) || 0) + 1;
userSpamViolations.set(userId, violations);
if (violations === 1) {
await message.author.send(' **注意**: 1分間に同じ発言を15回行ったためメッセージが
削除されました。もう一度行うと1日間タイムアウトになります。').catch(() => {});
if (reportChannel) {
await reportChannel.send(`@${username}さんが、${content}という発言を15回発言
したので、メッセージを削除しました。`).catch(() => {});
}
} else if (violations >= 2) {
try {
if (message.member?.moderatable) {
await message.member.timeout(24 * 60 * 60 * 1000, 'スパム連投2回目');
}
await message.author.send(' 1分間に同じ発言を15回以上行うスパム行為が2回続い
たため、1日間タイムアウトされました。').catch(() => {});
} catch (e) { console.error('タイムアウト失敗:', e.message); }
if (reportChannel) {
await reportChannel.send(`(2回目)@${username}さんが2回めの${content}という発
言を15回発言したので、削除と1日タイムアウトされました。`).catch(() => {});
}
userSpamViolations.set(userId, 0);
}
return;
}
}
// --- B. サーバー宣伝検知 ---
const isDiscordInvite = /(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9]+/
i.test(content);
if (isDiscordInvite && message.channel.id !== AD_CHANNEL_ID) {
try { if (message.deletable) await message.delete(); } catch (_) {}
const violations = (userAdViolations.get(userId) || 0) + 1;
userAdViolations.set(userId, violations);
const channelName = message.channel.name;
if (violations === 1) {
await message.author.send(` **注意**: 許可されていないチャンネル(#${channelName})
でサーバーの宣伝を行ったためメッセージが削除されました。もう一度行うと1日間タイムアウトになります。`).catch(()
=> {});
if (reportChannel) {
await reportChannel.send(`@${username}さんが宣伝以外のチャンネル(${channelName})
でサーバーの宣伝をしたため、削除されました。`).catch(() => {});
}
} else if (violations >= 2) {
try {
if (message.member?.moderatable) {
await message.member.timeout(24 * 60 * 60 * 1000, '他サーバー宣伝2回目');
}
await message.author.send(' 許可されていない場所での宣伝が2回続いたため、1日間タイ
ムアウトされました。').catch(() => {});
} catch (e) { console.error('タイムアウト失敗:', e.message); }

if (reportChannel) {
await reportChannel.send(`(2回め)@${username}さんが宣伝以外のチャンネル($
{channelName})で2回目のサーバー宣伝をしたため、削除と1日間タイムアウトしました。`).catch(() => {});
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
