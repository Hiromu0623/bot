const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  StringSelectMenuBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ChannelType, 
  PermissionsBitField 
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Botが準備完了したときの処理
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

// メッセージ受信時の処理（コマンド実行用）
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // !ticket コマンドでチケット発行パネルを送信
  if (message.content === '!ticket') {
    const embed = new EmbedBuilder()
      .setTitle('チケット発行')
      .setDescription('カテゴリーを選択し、「チケットを発行する」ボタンを押してフォームを入力してください。')
      .setColor(0x0099FF);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('ticket_category')
      .setPlaceholder('カテゴリーを選択してください')
      .addOptions([
        {
          label: '質問・相談',
          value: '質問・相談',
          description: '一般的な相談や質問はこちらから',
        },
        {
          label: '通報',
          value: '通報',
          description: '規約違反者や問題行動の報告',
        },
        {
          label: 'その他',
          value: 'その他',
          description: '上記以外の問い合わせ',
        },
      ]);

    const button = new ButtonBuilder()
      .setCustomId('create_ticket')
      .setLabel('チケットを発行する')
      .setStyle(ButtonStyle.Primary);

    const row1 = new ActionRowBuilder().addComponents(selectMenu);
    const row2 = new ActionRowBuilder().addComponents(button);

    await message.channel.send({
      embeds: [embed],
      components: [row1, row2],
    });
  }
});

// インタラクション（ボタンやセレクトメニューの操作）処理
client.on('interactionCreate', async (interaction) => {
  // セレクトメニューの選択を一時保存する処理などが必要な場合はここに記述
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'ticket_category') {
      await interaction.reply({
        content: `カテゴリー「${interaction.values[0]}」を選択しました。「チケットを発行する」ボタンを押してください。`,
        ephemeral: true,
      });
    }
  }

  // チケット作成ボタンが押されたときの処理
  if (interaction.isButton()) {
    if (interaction.customId === 'create_ticket') {
      const guild = interaction.guild;
      const user = interaction.user;

      // チケットチャンネルの作成
      const channel = await guild.channels.create({
        name: `ticket-${user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: guild.id, // @everyone は見えないようにする
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: user.id, // チケット作成者だけが見えるようにする
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
            ],
          },
        ],
      });

      await interaction.reply({
        content: `チケットを作成しました: ${channel}`,
        ephemeral: true,
      });

      await channel.send({
        content: `${user} 様、お問い合わせありがとうございます。スタッフの対応をお待ちください。`,
      });
    }
  }
});

// Renderの環境変数からトークンを取得してログイン
client.login(process.env.DISCORD_TOKEN || process.env.TOKEN);
