// Copy for groups the bot has been added to but that aren't linked to a workspace yet.
// Pure; no I/O. Used by the webhook for /help (and a pointer for other commands) before /auth.

import { escapeHtml } from '@/lib/privacy';

function dashboardLink(appUrl: string): string {
  const base = appUrl.replace(/\/+$/, '');
  const label = base.replace(/^https?:\/\//, '');
  return `<a href="${escapeHtml(base)}/manage">${escapeHtml(label)}/manage</a>`;
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
