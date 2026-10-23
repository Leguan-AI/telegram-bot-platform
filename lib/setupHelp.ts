// Copy for groups the bot has been added to but that aren't linked to a workspace yet.
// Pure; no I/O. Used by the webhook for /help (and a pointer for other commands) before /auth.

import { escapeHtml } from '@/lib/privacy';

const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

function dashboardLink(appUrl: string): string {
  const base = appUrl.replace(/\/+$/, '');
  const label = base.replace(/^https?:\/\//, '');
  return `<a href="${escapeAttr(base)}/manage">${escapeHtml(label)}/manage</a>`;
}

/** `/help` reply for a group that is not linked to a workspace yet: the setup steps. */
export function getUnlinkedHelp(appUrl: string): string {
  return (
    `<b>👋 Let's get this group set up</b>\n\n` +
    `This group isn't linked to a workspace yet, so I can't answer questions here until it is.\n\n` +
    `1. <b>Turn on Topics</b> in this group (Group settings → Topics). I only work in forum groups.\n` +
    `2. <b>Sign in</b> at ${dashboardLink(appUrl)} with your email (you'll get a magic link) and create a workspace if you don't have one.\n` +
    `3. Open the workspace and click <b>Generate Link Command</b>. You'll get a one-time code that's valid for 10 minutes.\n` +
    `4. As a <b>group admin</b>, send it here: <code>/auth &lt;code&gt;</code>\n\n` +
    `Once linked, send /help again to see everything I can do. <code>/whoami</code> shows this chat's ids if you need them for debugging.`
  );
}

/** One-line nudge for commands/mentions that need a linked group. */
export const UNLINKED_NUDGE = `This group isn't linked to a workspace yet — send /help for setup steps.`;

/**
 * `/help` for a linked group.
 *
 * The repository section is shown whether or not this workspace has connected GitHub:
 * resolving that needs a database round trip and a GitHub call, and the wording works
 * either way. What it must not do is leave the access rule unsaid — linking a repository
 * makes it readable by everyone in the group (#21 §8), and the people affected by that
 * are exactly the people who read /help.
 *
 * The provider names come from resolveProvider in lib/model.ts; change them together.
 *
 * The command list at the top mentions pinning as well as the Repositories section below,
 * because that list is what people actually read: a reader who went through the whole of
 * this still came away thinking pins were not offered when only the section mentioned
 * them. Keep both, and keep the command itself in the line — naming the capability
 * without naming `/repos pin` leaves someone to guess at the spelling, which is easy to
 * get wrong by one letter.
 */
export function buildLinkedHelp(botUsername: string): string {
  const mention = `@${escapeHtml(botUsername)}`;

  return (
    `<b>Telegram Bot Platform Help</b>\n\n` +
    `• Use <code>/context</code> to see what documentation I'm answering from in this topic.\n` +
    `• Use <code>/push topic</code> or <code>/push group</code> as a <i>reply</i> to a message, or as the caption of an attached .txt/.md file, to save it as context for the topic or group (group admins only).\n` +
    `• Use <code>/recap [N]</code> to summarize the last N messages here (default 20).\n` +
    `• Use <code>/repos</code> to see which code repositories I can read here. Group admins can narrow a topic to specific ones with <code>/repos pin &lt;repo&gt;</code>.\n` +
    `• Use <code>/whoami</code> to show this chat's ids (useful for setup/diagnostics).\n` +
    `• Mention me <code>${mention} &lt;question&gt;</code> inside a topic to ask a question.\n\n` +
    `<b>📦 Repositories</b>\n` +
    `If your workspace has connected a GitHub account, I can read the repositories an admin has linked to this group, and I'll look in them when you ask about the code. I read only — I never write code, open pull requests or file issues.\n\n` +
    `• <b>Everyone here can reach what is linked.</b> Linking a repository to this group means any member can get its contents through me, by asking. Only workspace admins can link, in the dashboard.\n` +
    `• <b>Sensitive files are never available to me.</b> Files that look like secrets — .env files, private keys, credential stores — are blocked by name, and I'll tell you that rather than pretend they don't exist.\n` +
    `• <b>Topics can narrow it.</b> <code>/repos</code> shows what's in scope here; group admins can use <code>/repos pin &lt;repo&gt;</code> to limit a topic to certain repositories, and <code>/repos clear</code> to go back to the group's full list. Pins can only narrow, never widen.\n` +
    `• <b>Repository content goes to AI providers.</b> To answer, I send the relevant repository content to third-party AI model providers — currently Anthropic and DeepSeek — in the same way I send your messages and context documents. The provider list can change.\n` +
    `• <b>Disconnecting</b> is done by whoever owns the GitHub account, from GitHub's own settings (Settings → Applications → Installed GitHub Apps), or by a workspace admin from the GitHub tab in the dashboard.`
  );
}
