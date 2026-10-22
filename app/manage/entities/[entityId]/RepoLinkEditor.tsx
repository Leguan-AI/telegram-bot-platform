'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

/** A repository the entity's installation currently contains (from GitHub, never stored). */
export interface RepoOption {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

/** A row of public.repo_links, as list_repo_links returns it. */
export interface RepoLinkRow {
  id: string;
  repo_id: number;
  group_id: string | null;
  group_name: string | null;
  telegram_chat_id: number | null;
  thread_id: string | null;
  thread_name: string | null;
  telegram_thread_id: number | null;
  linked_by_profile_id: string | null;
  linked_by_tg_user_id: number | null;
  created_at: string;
}

/** Reasons the save endpoint can refuse, in the admin's own terms. */
function saveErrorMessage(error: string, rejected?: number[]): string {
  switch (error) {
    case 'unauthenticated':
      return 'Your session expired. Reload the page and sign in again.';
    case 'forbidden':
      return 'You are not an admin of this directory.';
    case 'not_connected':
      return 'No GitHub account is connected to this directory.';
    case 'pending_confirmation':
      return 'The GitHub connection still needs to be confirmed before repositories can be linked.';
    case 'suspended':
      return 'The GitHub installation is suspended, so repositories cannot be linked right now.';
    case 'repo_not_in_installation':
      return `Some repositories are not shared with this directory any more${
        rejected?.length ? ` (${rejected.length})` : ''
      }. Reload to see the current list.`;
    case 'repo_pin_would_widen':
      return 'A topic can only be pinned to repositories already linked to its group.';
    case 'app_not_configured':
      return 'The GitHub App is not configured on the server yet.';
    default:
      return 'Could not save the repository links. Please try again.';
  }
}

interface RepoLinkSectionProps {
  entityId: string;
  /** Repositories the installation contains; empty means the owner shared none. */
  repositories: RepoOption[];
  /** Links already saved at this exact scope. */
  links: RepoLinkRow[];
  /** null for entity-level, a group id for group-level. */
  groupId: string | null;
  /** A topic pin; requires groupId. */
  threadId?: string | null;
  heading: string;
  description: string;
  onSaved: () => void | Promise<void>;
}

/**
 * The picker for one scope (#21 §3). Saving replaces the set at this scope alone, through
 * `POST /api/github/repo-links`, which re-checks on the server that every id is still in
 * the installation — the browser's selection is a request, not an authority.
 */
export function RepoLinkSection({
  entityId,
  repositories,
  links,
  groupId,
  threadId = null,
  heading,
  description,
  onSaved,
}: RepoLinkSectionProps) {
  const linkedIds = links.map((l) => l.repo_id);
  const [selected, setSelected] = useState<number[]>(linkedIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const dirty =
    selected.length !== linkedIds.length || selected.some((id) => !linkedIds.includes(id));

  const linkedBy = new Map(links.map((l) => [l.repo_id, l]));

  const toggle = (id: number) => {
    setSuccess('');
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError(saveErrorMessage('unauthenticated'));
        return;
      }

      const res = await fetch('/api/github/repo-links', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ entityId, groupId, threadId, repoIds: selected }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(saveErrorMessage(payload?.error || 'server_error', payload?.rejected));
        return;
      }

      setSuccess(
        `Saved — ${payload.total} repositor${payload.total === 1 ? 'y' : 'ies'} linked here` +
          (payload.added || payload.removed
            ? ` (${payload.added} added, ${payload.removed} removed).`
            : '.')
      );
      await onSaved();
    } catch (err: any) {
      setError(saveErrorMessage('server_error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <h3 style={{ fontSize: '1rem', marginBottom: '0.35rem' }}>{heading}</h3>
      <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>{description}</p>

      {error && <div className="alert alert-error" style={{ marginTop: '1rem' }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginTop: '1rem' }}>{success}</div>}

      {repositories.length === 0 ? (
        <p style={{ fontSize: '0.9rem', marginTop: '1rem' }}>
          The owner has not shared any repositories with this directory yet.
        </p>
      ) : (
        <>
          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {repositories.map((repo) => {
              const link = linkedBy.get(repo.id);
              return (
                <label
                  key={repo.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.6rem',
                    fontSize: '0.9rem',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(repo.id)}
                    onChange={() => toggle(repo.id)}
                    disabled={saving}
                    style={{ marginTop: '0.2rem' }}
                  />
                  <span>
                    <code>{repo.fullName}</code>
                    {!repo.private && (
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}> · public</span>
                    )}
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                      {' '}· {repo.defaultBranch}
                    </span>
                    {repo.description && (
                      <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                        {repo.description}
                      </span>
                    )}
                    {link && (
                      <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                        linked {new Date(link.created_at).toLocaleDateString()}
                        {link.linked_by_profile_id ? ` by ${link.linked_by_profile_id}` : ''}
                        {link.linked_by_tg_user_id ? ` by Telegram user ${link.linked_by_tg_user_id}` : ''}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          <button
            onClick={handleSave}
            className="btn btn-primary"
            disabled={saving || !dirty}
            style={{ marginTop: '1rem', padding: '0.5rem 1rem', fontSize: '0.875rem' }}
          >
            {saving ? 'Saving...' : dirty ? 'Save repositories' : 'Saved'}
          </button>
        </>
      )}
    </div>
  );
}
