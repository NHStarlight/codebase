import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from './embeds.js';
import { createSelectMenu } from './components.js';
import { BotConfig } from '../config/bot.js';
import { COMMAND_ALIASES_BY_COMMAND } from './commandAliases.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CATEGORY_SELECT_ID = 'help-category-select';
export const ALL_COMMANDS_ID = 'help-all-commands';

const BRAND_NAME = BotConfig.brand?.name || 'nh_starlightsercurity';
const DEFAULT_PREFIX = BotConfig.prefix || 'nh!';

const CATEGORY_ICONS = {
    Core: 'ℹ️',
    Moderation: '🛡️',
    Fun: '🎮',
    Leveling: '📊',
    Utility: '🔧',
    Ticket: '🎫',
    Welcome: '👋',
    Giveaway: '🎉',
    ServerStats: '🔢',
    Tools: '🛠️',
    Search: '🔍',
    Reaction_roles: '🎭',
    Community: '👥',
    Birthday: '🎂',
    Verification: '✅',
    Voice: '🔊',
    Logging: '📝',
    JoinToCreate: '🎤',
};

const ALIASES_BY_COMMAND = Object.entries(COMMAND_ALIASES_BY_COMMAND).reduce((acc, [cmd, aliases]) => {
    acc[cmd] = aliases;
    return acc;
}, {});

function brandFooter(suffix = '') {
    const base = BRAND_NAME;
    return suffix ? `${base} | ${suffix}` : base;
}

function formatCategoryLabel(folderName) {
    if (!folderName) return 'Other';
    return folderName
        .split(/[_-]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
}

function formatCommandUsage(name) {
    const aliases = ALIASES_BY_COMMAND[name];
    const prefixParts = aliases?.length
        ? aliases.slice(0, 3).map((a) => `\`${DEFAULT_PREFIX}${a}\``)
        : [`\`${DEFAULT_PREFIX}${name}\``];
    return `/${name} · ${prefixParts.join(' · ')}`;
}

/**
 * Primary commands only (no duplicate alias keys).
 * @param {import('discord.js').Client} client
 */
export function collectPrimaryCommands(client) {
    if (!client?.commands?.size) {
        return [];
    }

    const seen = new Set();
    const list = [];

    for (const command of client.commands.values()) {
        const name = command?.data?.name;
        if (!name || seen.has(name)) {
            continue;
        }
        seen.add(name);

        list.push({
            name,
            description: command.data.description || 'No description available',
            category: command.category || 'Other',
            categoryLabel: formatCategoryLabel(command.category),
            icon: CATEGORY_ICONS[command.category] || '🔹',
        });
    }

    return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {import('discord.js').Client} client
 */
export async function getCategoryFolders() {
    const commandsPath = path.join(__dirname, '../commands');
    return (await fs.readdir(commandsPath, { withFileTypes: true }))
        .filter((dirent) => dirent.isDirectory() && dirent.name !== 'modules')
        .map((dirent) => dirent.name)
        .sort();
}

/**
 * Category select menu row (kept visible while paging).
 * @param {import('discord.js').Client} client
 */
export async function createHelpSelectRow(client) {
    const categoryDirs = await getCategoryFolders();
    const commandCount = collectPrimaryCommands(client).length;

    const options = [
        {
            label: '📋 All Commands',
            description: `View all ${commandCount} commands`,
            value: ALL_COMMANDS_ID,
        },
        ...categoryDirs.map((category) => {
            const label = formatCategoryLabel(category);
            const icon = CATEGORY_ICONS[category] || '🔹';
            return {
                label: `${icon} ${label}`,
                description: `Commands in ${label}`,
                value: category,
            };
        }),
    ];

    return createSelectMenu(CATEGORY_SELECT_ID, 'Select a category', options);
}

/**
 * @param {import('discord.js').Client} client
 * @param {number} currentPage
 * @param {number} totalPages
 * @param {string} category
 */
export async function buildHelpViewComponents(client, currentPage, totalPages, category = '') {
    const selectRow = await createHelpSelectRow(client);
    const pageRow = createHelpPaginationButtons(currentPage, totalPages, category);
    return [selectRow, pageRow];
}

/**
 * @param {import('discord.js').Client} client
 */
export async function createInitialHelpMenu(client) {
    const commandCount = collectPrimaryCommands(client).length;

    const embed = createEmbed({
        title: `🤖 ${BRAND_NAME}`,
        description:
            `Welcome to **${BRAND_NAME}** — ${BotConfig.brand?.tagline || 'your server security bot'}.\n\n` +
            `**Prefix:** \`${DEFAULT_PREFIX}\` · **Slash:** \`/\`\n` +
            `Use the menu below to browse every command.\n\n` +
            `**Moderation tip:** \`ban\` / \`${DEFAULT_PREFIX}b\` = **1 user** per use · ` +
            `\`massban\` / \`${DEFAULT_PREFIX}mban\` = **many users** in one command.`,
        color: 'primary',
    });

    embed.addFields(
        { name: '🛡️ Moderation', value: 'ban, kick, timeout, purge, lock…', inline: true },
        { name: '🎮 Fun', value: 'roll, flip, ship, fight…', inline: true },
        { name: '📊 Leveling', value: 'rank, leaderboard, XP setup', inline: true },
        { name: '🎫 Tickets', value: 'Support ticket system', inline: true },
        { name: '🎉 Giveaways', value: 'gcreate, gend, greroll', inline: true },
        { name: '✅ Verification', value: 'verify, autoverify, roles', inline: true },
    );
    embed.setFooter({ text: brandFooter(`${commandCount} commands`) });
    embed.setTimestamp();

    const bugReportButton = new ButtonBuilder()
        .setLabel('Contact Developer')
        .setStyle(ButtonStyle.Link)
        .setURL('https://discord.com/users/1198136184526864475');

    const selectRow = await createHelpSelectRow(client);
    const buttonRow = new ActionRowBuilder().addComponents(bugReportButton);

    return { embeds: [embed], components: [buttonRow, selectRow] };
}

export async function getAllCategories() {
    return getCategoryFolders();
}

/**
 * @param {string} categoryFolder
 * @param {number} page
 * @param {import('discord.js').Client} client
 */
export async function getCategoryEmbedAndPageCount(categoryFolder, page = 1, client) {
    const allCommands = collectPrimaryCommands(client).filter(
        (cmd) => cmd.category === categoryFolder,
    );

    const categoryLabel = formatCategoryLabel(categoryFolder);
    const icon = CATEGORY_ICONS[categoryFolder] || '🔹';
    const pageSize = 5;
    const totalPages = Math.ceil(allCommands.length / pageSize) || 1;
    const validPage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (validPage - 1) * pageSize;
    const pageCommands = allCommands.slice(startIndex, startIndex + pageSize);

    const embed = createEmbed({
        title: `${icon} ${categoryLabel} Commands`,
        description:
            allCommands.length === 0
                ? 'No commands in this category.'
                : `Page ${validPage} of ${totalPages} · **${allCommands.length}** command(s)`,
        color: 'primary',
    });

    for (const cmd of pageCommands) {
        embed.addFields({
            name: `• ${cmd.name}`,
            value: `${cmd.description}\n${formatCommandUsage(cmd.name)}`,
            inline: false,
        });
    }

    embed.setFooter({ text: brandFooter(`Page ${validPage}/${totalPages}`) });
    embed.setTimestamp();

    return { embed, totalPages, currentPage: validPage };
}

/**
 * @param {number} page
 * @param {import('discord.js').Client} client
 */
export async function getAllCommandsEmbedAndPageCount(page = 1, client) {
    const allCommands = collectPrimaryCommands(client);
    const pageSize = 8;
    const totalPages = Math.ceil(allCommands.length / pageSize) || 1;
    const validPage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (validPage - 1) * pageSize;
    const pageCommands = allCommands.slice(startIndex, startIndex + pageSize);

    const embed = createEmbed({
        title: `📋 All Commands — ${BRAND_NAME}`,
        description: `Page ${validPage} of ${totalPages} · **${allCommands.length}** commands · Prefix \`${DEFAULT_PREFIX}\``,
        color: 'primary',
    });

    for (const cmd of pageCommands) {
        embed.addFields({
            name: `${cmd.icon} /${cmd.name}`,
            value: `${cmd.description}\n${formatCommandUsage(cmd.name)}\n*${cmd.categoryLabel}*`,
            inline: false,
        });
    }

    embed.setFooter({ text: brandFooter(`Page ${validPage}/${totalPages}`) });
    embed.setTimestamp();

    return { embed, totalPages, currentPage: validPage };
}

export function createHelpPaginationButtons(currentPage, totalPages, category = '') {
    const canGoBack = currentPage > 1;
    const canGoNext = currentPage < totalPages;

    const backButton = new ButtonBuilder()
        .setCustomId(`help:back:${currentPage - 1}:${category}`)
        .setLabel('← Back')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canGoBack);

    const nextButton = new ButtonBuilder()
        .setCustomId(`help:next:${currentPage + 1}:${category}`)
        .setLabel('Next →')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canGoNext);

    return new ActionRowBuilder().addComponents(backButton, nextButton);
}
