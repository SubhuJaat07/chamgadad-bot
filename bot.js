import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActivityType,
  ChannelType,
  WebhookClient,
  Partials
} from "discord.js";

// ============================================================
// CONFIG
// ============================================================
const OWNERS = (process.env.OWNER_IDS || "").split(",").filter(Boolean);
const PREFIX = process.env.PREFIX || null; // optional prefix mode

// ============================================================
// IN-MEMORY STORES
// ============================================================
const afkUsers = new Map();       // userId -> { reason, timestamp, guildId }
const afkBlacklist = new Set();    // userIds who are blacklisted from AFK
const autoReactChannels = new Map(); // channelId -> Set<emoji>
const mimicWebhooks = new Map();   // channelId -> webhookId

// ============================================================
// CLIENT SETUP
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once("ready", async () => {
  console.log(`✅ ${client.user.tag} is online!`);
  client.user.setActivity("chamgadad mode", { type: ActivityType.Playing });

  // Register slash commands globally
  await registerCommands();
});

// ============================================================
// SLASH COMMAND DEFINITIONS
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName("mimic")
    .setDescription("Send a message as another user using webhook")
    .addUserOption(o => o.setName("user").setDescription("User to mimic").setRequired(true))
    .addStringOption(o => o.setName("message").setDescription("Message to send").setRequired(true))
    .addAttachmentOption(o => o.setName("image").setDescription("Optional image attachment"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("afk")
    .setDescription("Set yourself as AFK")
    .addStringOption(o => o.setName("reason").setDescription("AFK reason").setRequired(false).setMaxLength(200)),

  new SlashCommandBuilder()
    .setName("afkbreak")
    .setDescription("Remove someone from AFK (admin only)")
    .addUserOption(o => o.setName("user").setDescription("User to remove from AFK").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("afklist")
    .setDescription("List all AFK users in this server"),

  new SlashCommandBuilder()
    .setName("afkblacklist")
    .setDescription("Blacklist users from AFK system")
    .addSubcommand(s => s.setName("add").setDescription("Blacklist a user").addUserOption(o => o.setName("user").setDescription("User to blacklist").setRequired(true)))
    .addSubcommand(s => s.setName("remove").setDescription("Unblacklist a user").addUserOption(o => o.setName("user").setDescription("User to unblacklist").setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("View AFK blacklist"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("autoreact")
    .setDescription("Setup auto-reactions for a channel")
    .addSubcommand(s =>
      s.setName("add").setDescription("Add auto-react emoji")
        .addStringOption(o => o.setName("emoji").setDescription("Emoji (custom: <a:name:id> or unicode: 😂)").setRequired(true))
    )
    .addSubcommand(s =>
      s.setName("remove").setDescription("Remove an auto-react emoji")
        .addStringOption(o => o.setName("emoji").setDescription("Emoji to remove").setRequired(true))
    )
    .addSubcommand(s => s.setName("list").setDescription("List auto-reacts in this channel"))
    .addSubcommand(s => s.setName("clear").setDescription("Clear all auto-reacts in this channel"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
];

async function registerCommands() {
  try {
    const rest = client.rest;
    await rest.put(
      `/applications/${client.user.id}/commands`,
      { body: commands.map(c => c.toJSON()) }
    );
    console.log(`📋 Registered ${commands.length} slash commands.`);
  } catch (e) {
    console.error("❌ Failed to register commands:", e.message);
  }
}

// ============================================================
// INTERACTION HANDLER
// ============================================================
client.on("interactionCreate", async (interaction) => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === "mimic") return handleMimic(interaction);
    if (commandName === "afk") return handleAfk(interaction);
    if (commandName === "afkbreak") return handleAfkBreak(interaction);
    if (commandName === "afklist") return handleAfkList(interaction);
    if (commandName === "afkblacklist") return handleAfkBlacklist(interaction);
    if (commandName === "autoreact") return handleAutoReact(interaction);
  }
});

// ============================================================
// MESSAGE HANDLER — AFK ping detection + AutoReact
// ============================================================
client.on("messageCreate", async (message) => {
  // Ignore bots
  if (message.author.bot) return;

  // --- AFK PING CHECK ---
  if (message.mentions.users.size > 0) {
    for (const [userId, user] of message.mentions.users) {
      if (userId === message.author.id) continue;

      // Check if mentioned user is AFK
      if (afkUsers.has(userId) && !afkBlacklist.has(userId)) {
        const afk = afkUsers.get(userId);
        const duration = getDuration(afk.timestamp);
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x5865F2)
            .setDescription(`💤 **${user.username}** is AFK: *${afk.reason || "No reason"}*\n⏱️ Gone for: ${duration}`)
            .setFooter({ text: "They'll be back soon!" })]
        }).catch(() => {});
      }

      // If the sender was AFK and they came back, remove their AFK
      if (afkUsers.has(message.author.id)) {
        const oldAfk = afkUsers.get(message.author.id);
        const dur = getDuration(oldAfk.timestamp);
        afkUsers.delete(message.author.id);

        // Remove AFK from nickname if present
        if (message.member && message.member.nickname?.startsWith("[AFK] ")) {
          try { await message.member.setNickname(message.member.nickname.slice(6)); } catch {}
        }

        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x57F287)
            .setDescription(`👋 Welcome back **${message.author.username}**!\nYou were AFK for: ${dur}\nReason: *${oldAfk.reason || "No reason"}*`)]
        }).catch(() => {});
      }
    }
  }

  // Also check if sender comes back by just sending a message
  if (afkUsers.has(message.author.id)) {
    const oldAfk = afkUsers.get(message.author.id);
    const dur = getDuration(oldAfk.timestamp);
    afkUsers.delete(message.author.id);

    if (message.member && message.member.nickname?.startsWith("[AFK] ")) {
      try { await message.member.setNickname(message.member.nickname.slice(6)); } catch {}
    }

    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setDescription(`👋 Welcome back **${message.author.username}**!\nYou were AFK for: ${dur}`)]
    }).catch(() => {});
  }

  // --- AUTO-REACT ---
  const channelReacts = autoReactChannels.get(message.channel.id);
  if (channelReacts && channelReacts.size > 0) {
    for (const emoji of channelReacts) {
      try {
        await message.react(emoji);
      } catch {}
    }
  }
});

// ============================================================
// COMMAND: /mimic — Send message as webhook (looks like another user)
// ============================================================
async function handleMimic(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const target = interaction.options.getUser("user");
  const msg = interaction.options.getString("message");
  const image = interaction.options.getAttachment("image");

  try {
    // Create or get webhook for the channel
    let webhook;
    const existingWebhook = mimicWebhooks.get(interaction.channel.id);

    if (existingWebhook) {
      try {
        webhook = await interaction.channel.fetchWebhooks();
        webhook = webhook.find(w => w.id === existingWebhook);
      } catch {}
    }

    if (!webhook) {
      webhook = await interaction.channel.createWebhook({
        name: "Chamgadad Mimic",
        avatar: client.user.displayAvatarURL({ size: 128 }),
      });
      mimicWebhooks.set(interaction.channel.id, webhook.id);
    }

    await webhook.send({
      content: msg,
      username: target.username,
      avatarURL: target.displayAvatarURL({ size: 128 }),
      files: image ? [image.url] : undefined,
    });

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setDescription(`🎭 Mimicked **${target.username}** successfully!`)]
    });
  } catch (e) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`❌ Failed to mimic: ${e.message}`)]
    });
  }
}

// ============================================================
// COMMAND: /afk — Set AFK status
// ============================================================
async function handleAfk(interaction) {
  const reason = interaction.options.getString("reason") || "No reason specified";

  // Check blacklist
  if (afkBlacklist.has(interaction.user.id)) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription("🚫 You are blacklisted from using AFK.")],
      ephemeral: true
    });
  }

  afkUsers.set(interaction.user.id, {
    reason,
    timestamp: Date.now(),
    guildId: interaction.guild.id,
  });

  // Set nickname to [AFK]
  if (interaction.member) {
    const currentNick = interaction.member.nickname || interaction.member.user.username;
    if (!currentNick.startsWith("[AFK] ")) {
      try {
        await interaction.member.setNickname(`[AFK] ${currentNick}`.slice(0, 32));
      } catch {}
    }
  }

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(`💤 **${interaction.user.username}** is now AFK!\nReason: *${reason}*`)],
    ephemeral: false
  });
}

// ============================================================
// COMMAND: /afkbreak — Force remove AFK
// ============================================================
async function handleAfkBreak(interaction) {
  const target = interaction.options.getUser("user");

  if (!afkUsers.has(target.id)) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x808080)
        .setDescription(`ℹ️ **${target.username}** is not AFK.`)],
      ephemeral: true
    });
  }

  afkUsers.delete(target.id);

  // Remove [AFK] from nickname
  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (member && member.nickname?.startsWith("[AFK] ")) {
    try { await member.setNickname(member.nickname.slice(6)); } catch {}
  }

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x57F287)
      .setDescription(`🔓 **${target.username}**'s AFK has been broken!`)]
  });
}

// ============================================================
// COMMAND: /afklist — List AFK users
// ============================================================
async function handleAfkList(interaction) {
  const guildAfk = [];
  for (const [userId, data] of afkUsers) {
    if (data.guildId === interaction.guild.id) {
      const user = await client.users.fetch(userId).catch(() => null);
      if (user) {
        guildAfk.push({
          user,
          reason: data.reason,
          duration: getDuration(data.timestamp),
        });
      }
    }
  }

  if (guildAfk.length === 0) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x808080)
        .setDescription("✅ No one is AFK in this server!")]
    });
  }

  const list = guildAfk.map((a, i) =>
    `${i + 1}. **${a.user.username}** — *${a.reason}*\n   └ ⏱️ ${a.duration}`
  ).join("\n\n");

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`💤 AFK Users (${guildAfk.length})`)
      .setDescription(list.slice(0, 4000))
      .setFooter({ text: `${guildAfk.length} user(s) currently AFK` })]
  });
}

// ============================================================
// COMMAND: /afkblacklist — Manage AFK blacklist
// ============================================================
async function handleAfkBlacklist(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "add") {
    const user = interaction.options.getUser("user");
    afkBlacklist.add(user.id);

    // Also remove from AFK if currently AFK
    if (afkUsers.has(user.id)) {
      afkUsers.delete(user.id);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (member && member.nickname?.startsWith("[AFK] ")) {
        try { await member.setNickname(member.nickname.slice(6)); } catch {}
      }
    }

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`🚫 **${user.username}** has been blacklisted from AFK.\nThey can no longer use /afk and their AFK status won't show to others.`)]
    });
  }

  if (sub === "remove") {
    const user = interaction.options.getUser("user");
    if (!afkBlacklist.has(user.id)) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x808080)
          .setDescription(`ℹ️ **${user.username}** is not AFK blacklisted.`)],
        ephemeral: true
      });
    }
    afkBlacklist.delete(user.id);
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setDescription(`✅ **${user.username}** has been removed from AFK blacklist.`)]
    });
  }

  if (sub === "list") {
    if (afkBlacklist.size === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x808080)
          .setDescription("📋 AFK blacklist is empty.")]
      });
    }

    const list = [];
    for (const uid of afkBlacklist) {
      const user = await client.users.fetch(uid).catch(() => null);
      list.push(`${list.length + 1}. <@${uid}> — ${user?.tag || "Unknown"} (\`${uid}\`)`);
    }

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("🚫 AFK Blacklist")
        .setDescription(list.join("\n"))
        .setFooter({ text: `${afkBlacklist.size} user(s) blacklisted` })]
    });
  }
}

// ============================================================
// COMMAND: /autoreact — Auto-react to messages in a channel
// ============================================================
async function handleAutoReact(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "add") {
    const emoji = interaction.options.getString("emoji");

    // Validate emoji
    if (!isValidEmoji(emoji)) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setDescription(`❌ Invalid emoji: \`${emoji}\`\nUse unicode emojis (😂, ❤️) or custom emojis (<a:name:id>)`)],
        ephemeral: true
      });
    }

    if (!autoReactChannels.has(interaction.channel.id)) {
      autoReactChannels.set(interaction.channel.id, new Set());
    }
    autoReactChannels.get(interaction.channel.id).add(emoji);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setDescription(`✅ Auto-react added: ${emoji} in <#${interaction.channel.id}>\n\nCurrent auto-reacts: ${[...autoReactChannels.get(interaction.channel.id)].join(" ")}`)]
    });
  }

  if (sub === "remove") {
    const emoji = interaction.options.getString("emoji");
    const channelReacts = autoReactChannels.get(interaction.channel.id);

    if (!channelReacts || !channelReacts.has(emoji)) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x808080)
          .setDescription(`ℹ️ ${emoji} is not in auto-react list for this channel.`)],
        ephemeral: true
      });
    }

    channelReacts.delete(emoji);
    if (channelReacts.size === 0) autoReactChannels.delete(interaction.channel.id);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setDescription(`✅ Removed ${emoji} from auto-react in <#${interaction.channel.id}>`)]
    });
  }

  if (sub === "list") {
    const channelReacts = autoReactChannels.get(interaction.channel.id);

    if (!channelReacts || channelReacts.size === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x808080)
          .setDescription("ℹ️ No auto-reacts set for this channel.\n\nUse `/autoreact add <emoji>` to add one.")]
      });
    }

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🔄 Auto-Reacts — <#${interaction.channel.id}>`)
        .setDescription([...channelReacts].join(" "))
        .setFooter({ text: `${channelReacts.size} emoji(s)` })]
    });
  }

  if (sub === "clear") {
    autoReactChannels.delete(interaction.channel.id);
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setDescription(`✅ Cleared all auto-reacts in <#${interaction.channel.id}>`)]
    });
  }
}

// ============================================================
// HELPERS
// ============================================================

/** Check if a string is a valid emoji (unicode or Discord custom) */
function isValidEmoji(emoji) {
  // Discord custom emoji: <a:name:id> or <name:id>
  if (/^<a?:[a-zA-Z0-9_]+:\d{17,20}>$/.test(emoji)) return true;
  // Unicode emoji: has no letters/numbers, just symbols
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{200D}\u{FE0F}]+$/u.test(emoji) && !/[a-zA-Z0-9]/.test(emoji)) return true;
  return false;
}

/** Get human-readable duration from timestamp */
function getDuration(timestamp) {
  const ms = Date.now() - timestamp;
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

// ============================================================
// LOGIN
// ============================================================
client.login(process.env.DISCORD_TOKEN);
