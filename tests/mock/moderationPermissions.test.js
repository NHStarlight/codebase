import test from 'node:test';
import assert from 'node:assert/strict';
import { MockGuild } from '../mocks/MockGuild.js';
import { MockMember } from '../mocks/MockMember.js';
import { MockRole } from '../mocks/MockRole.js';
import { MockChannel } from '../mocks/MockChannel.js';
import { ModerationService } from '../../src/services/moderationService.js';

// ============================================================
// MODERATION PERMISSIONS — MOCK TESTS
// Covers: owner protection, self-target, bot-target, hierarchy
// ============================================================

function setupGuild({ ownerId, moderatorRolePos, targetRolePos, moderatorId, targetId, botId }) {
    const ownerRole = new MockRole({ id: 'role-owner', name: 'Owner', position: 99 });
    const modRole = new MockRole({ id: 'role-mod', name: 'Mod', position: moderatorRolePos });
    const targetRole = new MockRole({ id: 'role-target', name: 'Member', position: targetRolePos });
    const botRole = new MockRole({ id: 'role-bot', name: 'BotRole', position: 98 });
    const everyoneRole = new MockRole({ id: 'guild-001', name: '@everyone', position: 0 });

    const roles = [everyoneRole, ownerRole, modRole, targetRole, botRole];

    const moderator = new MockMember({
        id: moderatorId,
        permissions: ['ModerateMembers', 'BanMembers', 'KickMembers'],
        roles: [modRole, everyoneRole],
        isOwner: moderatorId === ownerId,
    });

    const target = new MockMember({
        id: targetId,
        permissions: [],
        roles: [targetRole, everyoneRole],
        isOwner: targetId === ownerId,
    });

    const botMember = new MockMember({
        id: botId,
        permissions: ['ADMINISTRATOR'],
        roles: [botRole, everyoneRole],
    });
    botMember.user.bot = true;
    botMember.user.tag = 'Bot#0000';
    botMember.user.id = botId;

    const channel = new MockChannel({ id: 'channel-001', name: 'general' });

    const guild = new MockGuild({
        id: 'guild-001',
        name: 'TestGuild',
        ownerId: ownerId,
        members: [moderator, target, botMember],
        roles: roles,
        channels: [channel],
    });

    guild.members.me = botMember;
    guild.client.user = { id: botId, tag: 'Bot#0000', bot: true };
    channel.guild = guild;

    moderator.guild = guild;
    target.guild = guild;

    return { guild, moderator, target, botMember, channel };
}

// ============================================================
// OWNER PROTECTION TESTS
// ============================================================

test('ModerationService.validateHierarchy — rejects actions against owner', () => {
    const { guild, moderator, target } = setupGuild({
        ownerId: 'owner-001',
        moderatorId: 'mod-001',
        targetId: 'owner-001',
        moderatorRolePos: 50,
        targetRolePos: 99,
        botId: 'bot-001',
    });

    const result = ModerationService.validateHierarchy(moderator, target, 'ban');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('server owner'), `Expected owner protection message, got: ${result.error}`);
});

test('ModerationService.validateHierarchy — allows owner to act on anyone', () => {
    const { guild, moderator, target } = setupGuild({
        ownerId: 'owner-001',
        moderatorId: 'owner-001',
        targetId: 'target-001',
        moderatorRolePos: 99,
        targetRolePos: 50,
        botId: 'bot-001',
    });

    const result = ModerationService.validateHierarchy(moderator, target, 'ban');
    assert.equal(result.valid, true);
});

test('ModerationService.isOwnerProtected — detects owner correctly', () => {
    const { guild } = setupGuild({
        ownerId: 'owner-001',
        moderatorId: 'mod-001',
        targetId: 'owner-001',
        moderatorRolePos: 50,
        targetRolePos: 99,
        botId: 'bot-001',
    });

    assert.equal(ModerationService.isOwnerProtected(guild, 'owner-001'), true);
    assert.equal(ModerationService.isOwnerProtected(guild, 'target-001'), false);
    assert.equal(ModerationService.isOwnerProtected(null, 'owner-001'), false);
});

// ============================================================
// ROLE HIERARCHY TESTS
// ============================================================

test('ModerationService.validateHierarchy — rejects lower role acting on higher role', () => {
    const { guild, moderator, target } = setupGuild({
        ownerId: 'owner-001',
        moderatorId: 'mod-001',
        targetId: 'target-001',
        moderatorRolePos: 30,
        targetRolePos: 50,
        botId: 'bot-001',
    });

    const result = ModerationService.validateHierarchy(moderator, target, 'kick');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('equal or higher role'), `Expected hierarchy message, got: ${result.error}`);
});

test('ModerationService.validateHierarchy — accepts equal role (existing behavior)', () => {
    const { guild, moderator, target } = setupGuild({
        ownerId: 'owner-001',
        moderatorId: 'mod-001',
        targetId: 'target-001',
        moderatorRolePos: 50,
        targetRolePos: 50,
        botId: 'bot-001',
    });

    const result = ModerationService.validateHierarchy(moderator, target, 'kick');
    assert.equal(result.valid, false);
});

test('ModerationService.validateHierarchy — allows higher role acting on lower role', () => {
    const { guild, moderator, target } = setupGuild({
        ownerId: 'owner-001',
        moderatorId: 'mod-001',
        targetId: 'target-001',
        moderatorRolePos: 70,
        targetRolePos: 30,
        botId: 'bot-001',
    });

    const result = ModerationService.validateHierarchy(moderator, target, 'kick');
    assert.equal(result.valid, true);
});

// ============================================================
// BOT HIERARCHY TESTS
// ============================================================

test('ModerationService.validateBotHierarchy — rejects when bot is lower than target', () => {
    const { guild, target } = setupGuild({
        ownerId: 'owner-001',
        moderatorId: 'mod-001',
        targetId: 'target-001',
        moderatorRolePos: 50,
        targetRolePos: 99,
        botId: 'bot-001',
    });

    const result = ModerationService.validateBotHierarchy(guild.client, target, 'ban');
    assert.equal(result.valid, false);
});

// ============================================================
// EDGE CASES
// ============================================================

test('ModerationService.validateHierarchy — handles null moderator', () => {
    const result = ModerationService.validateHierarchy(null, {}, 'ban');
    assert.equal(result.valid, false);
});

test('ModerationService.validateHierarchy — handles null target', () => {
    const { moderator } = setupGuild({
        ownerId: 'owner-001',
        moderatorId: 'mod-001',
        targetId: 'target-001',
        moderatorRolePos: 50,
        targetRolePos: 30,
        botId: 'bot-001',
    });

    const result = ModerationService.validateHierarchy(moderator, null, 'ban');
    assert.equal(result.valid, false);
});