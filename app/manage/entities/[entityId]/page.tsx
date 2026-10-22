'use client';

import { Fragment, useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';
import {
  GITHUB_CONNECT_DISCLOSURES,
  ALL_REPOS_WARNING,
  ALL_REPOS_SHARED_NOTE,
} from '@/lib/githubConnectUi';
import '../../manage.css';
import { ContextEditor, ContextDocTable, type ContextDoc } from './ContextEditor';
import { RepoLinkSection, type RepoLinkRow, type RepoOption } from './RepoLinkEditor';

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Agent Platform';

interface Entity {
  id: string;
  slug: string;
  display_name: string;
  owner_profile_id: string;
}

interface GithubConnection {
  id: string;
  installation_id: number;
  account_id: number;
  account_login: string;
  account_type: 'User' | 'Organization';
  repository_selection: 'all' | 'selected';
  status: 'pending_confirmation' | 'active' | 'suspended';
  connected_by_github_login: string | null;
  connected_by_profile_id: string | null;
  invited_by_profile_id: string | null;
  confirmed_by_profile_id: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface GithubInvite {
  id: string;
  issued_by: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  completed_by_github_login: string | null;
  installation_id: number | null;
}

/** Revoked / used / expired / pending — derived, so the list needs no server-side state. */
function inviteState(inv: GithubInvite): 'revoked' | 'used' | 'expired' | 'pending' {
  if (inv.revoked_at) return 'revoked';
  if (inv.consumed_at) return 'used';
  if (new Date(inv.expires_at).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

interface Authorization {
  id: string;
  profile_id: string | null;
  invited_email: string | null;
  role: 'admin' | 'editor' | 'viewer';
  status: 'active' | 'pending';
  granted_by: string;
}

export default function EntityDetails({ params }: { params: Promise<{ entityId: string }> }) {
  const router = useRouter();
  const { entityId } = use(params);

  const [user, setUser] = useState<any>(null);
  const [entity, setEntity] = useState<Entity | null>(null);
  const [authorizations, setAuthorizations] = useState<Authorization[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'settings' | 'team' | 'groups' | 'github'>('settings');

  // Form states
  const [displayName, setDisplayName] = useState('');
  const [entityError, setEntityError] = useState('');
  const [entitySuccess, setEntitySuccess] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);

  // Invite states
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'editor' | 'viewer'>('viewer');
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);

  // Group linking states
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [linkSuccess, setLinkSuccess] = useState('');
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [linkedGroups, setLinkedGroups] = useState<any[]>([]);

  // Context documents (visible to every member; editing is gated in the RPC and the UI)
  const [contextDocs, setContextDocs] = useState<ContextDoc[]>([]);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

  // GitHub connect states (#21 §2)
  const [githubConnection, setGithubConnection] = useState<GithubConnection | null>(null);
  const [githubInvites, setGithubInvites] = useState<GithubInvite[]>([]);
  const [githubError, setGithubError] = useState('');
  const [githubSuccess, setGithubSuccess] = useState('');
  const [githubBusy, setGithubBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  // Repository links (#21 §3). Repository names come from GitHub via the picker route;
  // only numeric ids are ever stored.
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([]);
  const [repoLinks, setRepoLinks] = useState<RepoLinkRow[]>([]);
  const [repoLoadError, setRepoLoadError] = useState('');
  const [repoLoading, setRepoLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace('/manage/login');
      } else {
        setUser(session.user);
        loadEntityData();
      }
    });
  }, [router, entityId]);

  const refreshContextDocs = async () => {
    const { data, error } = await supabase.rpc('list_context_docs', { p_entity: entityId });
    if (error) {
      console.warn('Failed to load context documents:', error);
      return;
    }
    setContextDocs((data || []) as ContextDoc[]);
    setContextLoaded(true);
  };

  const loadEntityData = async () => {
    setLoading(true);
    setEntityError('');
    try {
      // 1. Fetch Entity details (filtered by RLS)
      const { data: entityData, error: entityErr } = await supabase
        .from('entities')
        .select('id, slug, display_name, owner_profile_id')
        .eq('id', entityId)
        .maybeSingle();

      if (entityErr) throw entityErr;
      if (!entityData) {
        throw new Error('Entity not found or you do not have permission to view it.');
      }

      setEntity(entityData);
      setDisplayName(entityData.display_name);

      // 2. Fetch Authorizations
      const { data: authsData, error: authsErr } = await supabase
        .from('authorizations')
        .select('id, profile_id, invited_email, role, status, granted_by')
        .eq('entity_id', entityId);

      if (authsErr) throw authsErr;
      setAuthorizations(authsData || []);

      // 3. Fetch context documents
      await refreshContextDocs();

      // 4. Fetch Linked Groups (gated for owner/admin in RPC)
      const { data: { session } } = await supabase.auth.getSession();
      const sessionUser = session?.user;
      const isOwnerUser = entityData.owner_profile_id === sessionUser?.id;
      const isAdminUser = isOwnerUser || (authsData || []).some(
        (a: any) => a.profile_id === sessionUser?.id && a.role === 'admin' && a.status === 'active'
      );

      if (isAdminUser) {
        const { data: groupsData, error: groupsErr } = await supabase.rpc('list_entity_groups', {
          p_entity: entityId
        });
        if (!groupsErr) {
          setLinkedGroups(groupsData || []);
        } else {
          console.warn('Failed to load linked groups:', groupsErr);
        }

        await loadGithubData();
      }
    } catch (err: any) {
      setEntityError(err.message || 'Failed to load entity.');
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // GitHub connect (#21 §2). Every write goes through a SECURITY DEFINER function that
  // re-checks entity admin rights on the server; the browser is never trusted.
  // ---------------------------------------------------------------------------

  const loadGithubData = async () => {
    const { data: connData, error: connErr } = await supabase.rpc('get_github_connection', {
      p_entity: entityId,
    });
    if (connErr) {
      console.warn('Failed to load GitHub connection:', connErr);
      setGithubConnection(null);
    } else {
      setGithubConnection((connData || [])[0] || null);
    }

    const { data: invData, error: invErr } = await supabase.rpc('list_github_connect_invites', {
      p_entity: entityId,
    });
    if (invErr) {
      console.warn('Failed to load GitHub connect invites:', invErr);
      setGithubInvites([]);
    } else {
      setGithubInvites(invData || []);
    }

    // Only an active connection can hold links, and only then is the picker reachable.
    if (((connData || [])[0] || null)?.status === 'active') {
      await loadRepoData();
    } else {
      setRepoOptions([]);
      setRepoLinks([]);
    }
  };

  /**
   * The picker's two halves: the repositories the installation contains (live from
   * GitHub, through a server route that holds the installation token) and the links
   * already saved (straight from the database as `authenticated`).
   */
  const loadRepoData = async () => {
    setRepoLoading(true);
    setRepoLoadError('');
    try {
      const { data: linkData, error: linkErr } = await supabase.rpc('list_repo_links', {
        p_entity: entityId,
      });
      if (linkErr) throw linkErr;
      setRepoLinks((linkData || []) as RepoLinkRow[]);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setRepoLoadError('Your session expired. Reload the page and sign in again.');
        return;
      }

      const res = await fetch(`/api/github/repositories?entity=${encodeURIComponent(entityId)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRepoOptions([]);
        setRepoLoadError(
          payload?.error === 'app_not_configured'
            ? 'The GitHub App is not configured on the server yet, so the repository list is unavailable.'
            : 'Could not read the shared repositories from GitHub. Reload to try again.'
        );
        return;
      }
      setRepoOptions((payload.repositories || []) as RepoOption[]);
    } catch (err: any) {
      setRepoLoadError(err.message || 'Could not load repository links.');
    } finally {
      setRepoLoading(false);
    }
  };

  // §2a: mint a single-use state bound to this entity and this /manage user, then hand
  // off to GitHub. The admin authorizes as the GitHub owner themselves, so the
  // connection is active as soon as the callback verifies them.
  const handleConnectGithub = async () => {
    setGithubBusy(true);
    setGithubError('');
    setGithubSuccess('');
    try {
      const { data, error } = await supabase.rpc('mint_github_connect_token', {
        p_entity: entityId,
        p_kind: 'direct',
      });
      if (error) throw error;
      window.location.href = `/api/github/install?state=${encodeURIComponent(data)}`;
    } catch (err: any) {
      setGithubError(err.message || 'Failed to start the GitHub connection.');
      setGithubBusy(false);
    }
  };

  // §2b: the invitee is the GitHub owner and needs no account here. The link is shown
  // once, expires in 24 hours, and can be revoked below.
  const handleCreateInvite = async () => {
    setGithubBusy(true);
    setGithubError('');
    setGithubSuccess('');
    setInviteLink(null);
    try {
      const { data, error } = await supabase.rpc('mint_github_connect_token', {
        p_entity: entityId,
        p_kind: 'invite',
      });
      if (error) throw error;
      setInviteLink(`${window.location.origin}/github/connect?invite=${encodeURIComponent(data)}`);
      setInviteCopied(false);
      await loadGithubData();
    } catch (err: any) {
      setGithubError(err.message || 'Failed to create the invite.');
    } finally {
      setGithubBusy(false);
    }
  };

  const handleCopyInvite = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 1500);
    } catch (err) {
      // Graceful fallback: the link stays on screen to copy by hand
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    setGithubError('');
    setGithubSuccess('');
    try {
      const { error } = await supabase.rpc('revoke_github_connect_invite', {
        p_entity: entityId,
        p_invite: inviteId,
      });
      if (error) throw error;
      setGithubSuccess('Invite revoked.');
      setInviteLink(null);
      await loadGithubData();
    } catch (err: any) {
      setGithubError(err.message || 'Failed to revoke the invite.');
    }
  };

  // §2b step 6: until an admin confirms, the connection holds the entity's slot and
  // nothing else — no repo can be linked and no repo tool runs.
  const handleConfirmConnection = async () => {
    setGithubBusy(true);
    setGithubError('');
    setGithubSuccess('');
    try {
      const { error } = await supabase.rpc('confirm_github_connection', { p_entity: entityId });
      if (error) throw error;
      setGithubSuccess('Connection confirmed.');
      await loadGithubData();
    } catch (err: any) {
      setGithubError(err.message || 'Failed to confirm the connection.');
    } finally {
      setGithubBusy(false);
    }
  };

  const handleRejectConnection = async () => {
    if (!confirm('Reject this connection? The GitHub account will not be connected to this directory.')) return;
    setGithubBusy(true);
    setGithubError('');
    setGithubSuccess('');
    try {
      const { error } = await supabase.rpc('reject_github_connection', { p_entity: entityId });
      if (error) throw error;
      setGithubSuccess('Connection rejected. The slot is free again.');
      await loadGithubData();
    } catch (err: any) {
      setGithubError(err.message || 'Failed to reject the connection.');
    } finally {
      setGithubBusy(false);
    }
  };

  const handleDisconnectGithub = async () => {
    if (!confirm('Disconnect GitHub? Linked repositories are removed from every group in this directory.')) return;
    setGithubBusy(true);
    setGithubError('');
    setGithubSuccess('');
    try {
      const { error } = await supabase.rpc('disconnect_github_connection', { p_entity: entityId });
      if (error) throw error;
      setGithubSuccess('GitHub disconnected. Remove the installation on GitHub too if you no longer want it there.');
      await loadGithubData();
    } catch (err: any) {
      setGithubError(err.message || 'Failed to disconnect GitHub.');
    } finally {
      setGithubBusy(false);
    }
  };

  const handleUpdateEntity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entity) return;
    setSaveLoading(true);
    setEntityError('');
    setEntitySuccess('');

    try {
      const { error } = await supabase
        .from('entities')
        .update({ display_name: displayName.trim() })
        .eq('id', entity.id);

      if (error) throw error;
      setEntitySuccess('Settings saved successfully!');
      setEntity({ ...entity, display_name: displayName.trim() });
    } catch (err: any) {
      setEntityError(err.message || 'Failed to update settings.');
    } finally {
      setSaveLoading(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entity) return;
    setInviteLoading(true);
    setInviteError('');
    setInviteSuccess('');

    const targetEmail = inviteEmail.trim().toLowerCase();
    if (!targetEmail) return;

    try {
      // Call the secure invite_user RPC function
      const { error } = await supabase.rpc('invite_user', {
        p_entity_id: entity.id,
        p_email: targetEmail,
        p_role: inviteRole,
      });

      if (error) throw error;

      setInviteSuccess(`Successfully processed invite for ${targetEmail} as ${inviteRole}.`);
      setInviteEmail('');
      
      // Reload authorizations list
      const { data: authsData } = await supabase
        .from('authorizations')
        .select('id, profile_id, invited_email, role, status, granted_by')
        .eq('entity_id', entity.id);
      setAuthorizations(authsData || []);
    } catch (err: any) {
      setInviteError(err.message || 'Failed to send invite.');
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRevoke = async (authId: string) => {
    if (!entity || !confirm('Are you sure you want to revoke this user\'s access?')) return;
    setInviteError('');
    setInviteSuccess('');

    try {
      const { error } = await supabase
        .from('authorizations')
        .delete()
        .eq('id', authId);

      if (error) throw error;

      setInviteSuccess('Access revoked successfully.');
      setAuthorizations(authorizations.filter((a) => a.id !== authId));
    } catch (err: any) {
      setInviteError(err.message || 'Failed to revoke access.');
    }
  };

  const handleGenerateCode = async () => {
    if (!entity) return;
    setLinkLoading(true);
    setLinkError('');
    setLinkSuccess('');
    try {
      const { data, error } = await supabase.rpc('mint_link_token', {
        p_entity: entity.id,
      });

      if (error) throw error;

      setLinkCode(data);
      setCopied(false);
      setTimeLeft(600); // 10 minutes in seconds
    } catch (err: any) {
      setLinkError(err.message || 'Failed to generate link code.');
    } finally {
      setLinkLoading(false);
    }
  };

  const handleCopyCommand = async () => {
    if (!linkCode) return;
    try {
      await navigator.clipboard.writeText(`/auth ${linkCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // Graceful fallback: do not set copied and do not show toast
    }
  };

  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          setLinkCode(null);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [timeLeft]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: '#080c14', color: '#94a3b8' }}>
        <div>Loading directory settings...</div>
      </div>
    );
  }

  const isOwner = entity?.owner_profile_id === user?.id;
  const isAdmin = isOwner || authorizations.some((auth) => auth.profile_id === user?.id && auth.role === 'admin' && auth.status === 'active');
  const canEditContext = isOwner || authorizations.some(
    (auth) => auth.profile_id === user?.id && (auth.role === 'admin' || auth.role === 'editor') && auth.status === 'active'
  );
  const entityDocs = contextDocs.filter((d) => d.scope === 'entity');
  const groupDocs = (groupId: string) => contextDocs.filter((d) => d.group_id === groupId);

  return (
    <div className="manage-container">
      <header className="manage-header" style={{ marginBottom: '2rem' }}>
        <div className="brand">
          <Link href="/manage/dashboard" style={{ textDecoration: 'none', color: 'inherit' }}>
            {APP_NAME}
          </Link>
          <span style={{ color: 'var(--text-muted)', fontSize: '1rem', fontWeight: 450 }}>
            &nbsp;/&nbsp;{entity?.display_name}
          </span>
        </div>
        <div className="user-badge">
          <span>{user?.email}</span>
        </div>
      </header>

      {entityError && (
        <div className="card">
          <div className="alert alert-error">{entityError}</div>
          <Link href="/manage/dashboard" className="btn btn-secondary">
            Back to Dashboard
          </Link>
        </div>
      )}

      {entity && (
        <>
          <div className="tabs">
            <button
              onClick={() => setActiveTab('settings')}
              className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
            >
              General Settings
            </button>
            <button
              onClick={() => setActiveTab('team')}
              className={`tab-btn ${activeTab === 'team' ? 'active' : ''}`}
            >
              Team & Access
            </button>
            {isAdmin && (
              <button
                onClick={() => setActiveTab('groups')}
                className={`tab-btn ${activeTab === 'groups' ? 'active' : ''}`}
              >
                Linked Groups
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => setActiveTab('github')}
                className={`tab-btn ${activeTab === 'github' ? 'active' : ''}`}
              >
                GitHub
              </button>
            )}
          </div>

          {activeTab === 'settings' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            <div className="card">
              <h2>Entity Context</h2>
              {contextLoaded && contextDocs.length === 0 && (
                <div className="alert alert-info">
                  The bot has no context yet, so it has nothing to answer from. Add some background below to get started.
                </div>
              )}
              <p style={{ fontSize: '0.95rem' }}>
                This document applies to <strong>every group</strong> linked to this entity. Write or upload the background
                the bot should rely on: who you are, how things work, key terms. You can add more specific context to an
                individual group from the Linked Groups tab.
              </p>
              <ContextEditor
                key="entity-context"
                entityId={entity.id}
                groupId={null}
                canEdit={canEditContext}
                onSaved={refreshContextDocs}
              />
              {entityDocs.length > 0 && (
                <div style={{ marginTop: '2rem' }}>
                  <h3>Documents that apply to the whole entity</h3>
                  <ContextDocTable docs={entityDocs} />
                </div>
              )}
            </div>

            <div className="card">
              <h2>Directory Settings</h2>
              {entitySuccess && <div className="alert alert-success">{entitySuccess}</div>}
              
              <form onSubmit={handleUpdateEntity}>
                <div className="form-group">
                  <label className="form-label" htmlFor="dirName">Display Name</label>
                  <input
                    id="dirName"
                    type="text"
                    className="form-control"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                    disabled={saveLoading}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Slug (Directory Key)</label>
                  <input
                    type="text"
                    className="form-control"
                    value={entity.slug}
                    disabled
                    style={{ opacity: 0.6 }}
                  />
                  <p style={{ fontSize: '0.825rem', marginTop: '0.5rem', marginBottom: 0 }}>
                    Slugs are unique and immutable to preserve endpoint webhook integrity.
                  </p>
                </div>
                <button type="submit" className="btn btn-primary" disabled={saveLoading}>
                  {saveLoading ? 'Saving...' : 'Save Settings'}
                </button>
              </form>
            </div>
            </div>
          )}

          {activeTab === 'team' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              {/* Owner-only panel to invite users */}
              {isOwner && (
                <div className="card">
                  <h2>Invite Team Member</h2>
                  {inviteError && <div className="alert alert-error">{inviteError}</div>}
                  {inviteSuccess && <div className="alert alert-success">{inviteSuccess}</div>}

                  <form onSubmit={handleInvite} style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div className="form-group" style={{ flex: 1, minWidth: '250px', marginBottom: 0 }}>
                      <label className="form-label" htmlFor="invEmail">Email Address</label>
                      <input
                        id="invEmail"
                        type="email"
                        placeholder="collaborator@domain.com"
                        className="form-control"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        required
                        disabled={inviteLoading}
                      />
                    </div>
                    <div className="form-group" style={{ minWidth: '150px', marginBottom: 0 }}>
                      <label className="form-label" htmlFor="invRole">Role</label>
                      <select
                        id="invRole"
                        className="form-control"
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as any)}
                        disabled={inviteLoading}
                        style={{ height: '43px', padding: '0.5rem 1rem' }}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <button type="submit" className="btn btn-primary" style={{ height: '43px' }} disabled={inviteLoading}>
                      {inviteLoading ? 'Sending...' : 'Invite'}
                    </button>
                  </form>
                </div>
              )}

              {/* Members table */}
              <div className="card">
                <h2>Access Controls</h2>
                {authorizations.length === 0 ? (
                  <p style={{ margin: 0 }}>No additional team members. You are the sole administrator.</p>
                ) : (
                  <div className="table-container">
                    <table>
                      <thead>
                        <tr>
                          <th>Identity</th>
                          <th>Role</th>
                          <th>Status</th>
                          {isOwner && <th style={{ textAlign: 'right' }}>Actions</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {authorizations.map((auth) => (
                          <tr key={auth.id}>
                            <td style={{ verticalAlign: 'middle' }}>
                              {auth.status === 'active' ? (
                                <code style={{ fontSize: '0.85rem' }}>Profile: {auth.profile_id}</code>
                              ) : (
                                <span>{auth.invited_email}</span>
                              )}
                            </td>
                            <td style={{ verticalAlign: 'middle' }}>
                              <span className={`badge badge-${auth.role}`}>
                                {auth.role}
                              </span>
                            </td>
                            <td style={{ verticalAlign: 'middle' }}>
                              <span className={`badge badge-${auth.status}`}>
                                {auth.status}
                              </span>
                            </td>
                            {isOwner && (
                              <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
                                <button
                                  onClick={() => handleRevoke(auth.id)}
                                  className="btn btn-danger"
                                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.825rem' }}
                                >
                                  Revoke
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'groups' && isAdmin && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              <div className="card">
                <h2>Connect a Telegram Group</h2>
                {linkError && <div className="alert alert-error">{linkError}</div>}
                {linkSuccess && <div className="alert alert-success">{linkSuccess}</div>}
                
                <p style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-muted)' }}>
                  To link a Telegram group, generate a one-time link command below and execute it as a group administrator.
                </p>

                {!linkCode ? (
                  <button
                    onClick={handleGenerateCode}
                    className="btn btn-primary"
                    disabled={linkLoading}
                    style={{ marginTop: '1rem', alignSelf: 'flex-start' }}
                  >
                    {linkLoading ? 'Generating...' : 'Generate Link Command'}
                  </button>
                ) : (
                  <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div 
                      onClick={handleCopyCommand}
                      style={{
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px dashed rgba(255, 255, 255, 0.15)',
                        borderRadius: '6px',
                        padding: '1.25rem',
                        cursor: 'pointer',
                        position: 'relative',
                        transition: 'background 0.2s',
                      }}
                      className="code-copy-box"
                    >
                      <div style={{ fontFamily: 'monospace', fontSize: '1.1rem', color: '#60a5fa' }}>
                        /auth {linkCode}
                      </div>
                      <span style={{
                        position: 'absolute',
                        right: '12px',
                        top: '12px',
                        fontSize: '0.8rem',
                        color: 'var(--text-muted)',
                      }}>
                        {copied ? 'Copied!' : 'Click to Copy'}
                      </span>
                    </div>
                    <p style={{ margin: 0, fontSize: '0.85rem' }}>
                      💡 <strong>Instructions:</strong> Click the box above to copy the command, go to your Telegram group, and paste it. 
                      This code is valid for 10 minutes and can only be used once. Only group administrators can run this command.
                    </p>
                    {timeLeft !== null && (
                      <div style={{ fontSize: '0.85rem', color: '#fbbf24' }}>
                        Expires in: {Math.floor(timeLeft / 60)}m {timeLeft % 60}s
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Linked Groups List */}
              <div className="card">
                <h2>Linked Telegram Groups</h2>
                {linkedGroups.length === 0 ? (
                  <p style={{ margin: 0 }}>No groups linked yet.</p>
                ) : (
                  <div className="table-container">
                    <table>
                      <thead>
                        <tr>
                          <th>Group Name</th>
                          <th>Telegram Chat ID</th>
                          <th>Linked Date</th>
                          <th>Context</th>
                        </tr>
                      </thead>
                      <tbody>
                        {linkedGroups.map((g) => {
                          const docsForGroup = groupDocs(g.id);
                          const expanded = expandedGroupId === g.id;
                          return (
                            <Fragment key={g.id}>
                              <tr>
                                <td><strong>{g.display_name}</strong></td>
                                <td><code>{g.telegram_chat_id}</code></td>
                                <td>{new Date(g.created_at).toLocaleString()}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => setExpandedGroupId(expanded ? null : g.id)}
                                  >
                                    {docsForGroup.length} document{docsForGroup.length === 1 ? '' : 's'} · {expanded ? 'Close' : 'Manage'}
                                  </button>
                                </td>
                              </tr>
                              {expanded && (
                                <tr>
                                  <td colSpan={4} style={{ background: 'rgba(15, 23, 42, 0.4)' }}>
                                    <h3>Group context for {g.display_name}</h3>
                                    <p style={{ fontSize: '0.9rem' }}>
                                      Applies only to this group, in addition to the entity-wide context.
                                    </p>
                                    <ContextEditor
                                      key={`group-context-${g.id}`}
                                      entityId={entity.id}
                                      groupId={g.id}
                                      canEdit={canEditContext}
                                      onSaved={refreshContextDocs}
                                    />
                                    <div style={{ marginTop: '2rem' }}>
                                      <h3>Documents for this group</h3>
                                      <ContextDocTable docs={docsForGroup} />
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'github' && isAdmin && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              <div className="card">
                <h2>GitHub Connection</h2>
                {githubError && <div className="alert alert-error">{githubError}</div>}
                {githubSuccess && <div className="alert alert-success">{githubSuccess}</div>}

                {!githubConnection ? (
                  <>
                    <p style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-muted)' }}>
                      Connect one GitHub account or organization so the bot can read the code when
                      a group asks about the project. Only an <strong>owner</strong> of that account
                      can connect it — we verify that with GitHub.
                    </p>
                    <ul style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
                      {GITHUB_CONNECT_DISCLOSURES.map((line) => (
                        <li key={line} style={{ marginBottom: '0.35rem' }}>{line}</li>
                      ))}
                    </ul>
                    {/* §8: the recommendation belongs here, where the choice is still
                        ahead of whoever is about to make it. */}
                    <div className="alert alert-warning" style={{ marginTop: '1.25rem' }}>
                      <span>
                        <strong>On the GitHub screen, choose &ldquo;Only select repositories&rdquo;.</strong>{' '}
                        {ALL_REPOS_WARNING}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '1rem' }}>
                      <button
                        onClick={handleConnectGithub}
                        className="btn btn-primary"
                        disabled={githubBusy}
                      >
                        {githubBusy ? 'Working...' : 'Connect GitHub'}
                      </button>
                      <button
                        onClick={handleCreateInvite}
                        className="btn btn-secondary"
                        disabled={githubBusy}
                      >
                        Invite someone to connect GitHub
                      </button>
                    </div>
                    <p style={{ fontSize: '0.825rem', marginTop: '1rem', marginBottom: 0 }}>
                      Use <strong>Connect GitHub</strong> if you own the GitHub account yourself.
                      Use the invite if the account belongs to someone else, such as the developer
                      who owns the organization — you confirm their connection afterwards.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="table-container">
                      <table>
                        <tbody>
                          <tr>
                            <th style={{ width: '220px' }}>Status</th>
                            <td>
                              <span className={`badge badge-${githubConnection.status === 'active' ? 'active' : 'pending'}`}>
                                {githubConnection.status === 'pending_confirmation'
                                  ? 'pending confirmation'
                                  : githubConnection.status}
                              </span>
                            </td>
                          </tr>
                          <tr>
                            <th>GitHub account</th>
                            <td>
                              <strong>{githubConnection.account_login}</strong>{' '}
                              <span style={{ color: 'var(--text-muted)' }}>
                                ({githubConnection.account_type === 'Organization' ? 'organization' : 'personal account'})
                              </span>
                            </td>
                          </tr>
                          <tr>
                            <th>Repository selection</th>
                            <td>
                              {githubConnection.repository_selection === 'all'
                                ? 'All repositories'
                                : 'Only selected repositories'}
                            </td>
                          </tr>
                          <tr>
                            <th>Connected by</th>
                            <td>
                              {githubConnection.connected_by_github_login
                                ? `@${githubConnection.connected_by_github_login}`
                                : 'unknown'}{' '}
                              <span style={{ color: 'var(--text-muted)' }}>
                                on {new Date(githubConnection.created_at).toLocaleString()}
                              </span>
                            </td>
                          </tr>
                          {githubConnection.invited_by_profile_id && (
                            <tr>
                              <th>Invited by</th>
                              <td><code style={{ fontSize: '0.85rem' }}>{githubConnection.invited_by_profile_id}</code></td>
                            </tr>
                          )}
                          {githubConnection.confirmed_by_profile_id && (
                            <tr>
                              <th>Confirmed by</th>
                              <td>
                                <code style={{ fontSize: '0.85rem' }}>{githubConnection.confirmed_by_profile_id}</code>{' '}
                                {githubConnection.confirmed_at && (
                                  <span style={{ color: 'var(--text-muted)' }}>
                                    on {new Date(githubConnection.confirmed_at).toLocaleString()}
                                  </span>
                                )}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* Informational, not an error: the connection is fine, the scope is
                        simply wider than we recommend. */}
                    {githubConnection.repository_selection === 'all' && (
                      <div className="alert alert-info" style={{ marginTop: '1.5rem' }}>
                        <strong>All repositories are shared.</strong> {ALL_REPOS_SHARED_NOTE}
                      </div>
                    )}

                    {githubConnection.status === 'pending_confirmation' && (
                      <div style={{ marginTop: '1.5rem' }}>
                        <p style={{ fontSize: '0.95rem' }}>
                          <strong>{githubConnection.account_login}</strong>{' '}
                          ({githubConnection.repository_selection === 'all'
                            ? 'all repositories'
                            : 'selected repositories'}) was connected by{' '}
                          <strong>@{githubConnection.connected_by_github_login}</strong>. Confirm it
                          to make repositories linkable, or reject it to free the slot.
                        </p>
                        <p style={{ fontSize: '0.95rem' }}>
                          <strong>
                            Reject this if you do not recognise{' '}
                            {githubConnection.connected_by_github_login
                              ? `@${githubConnection.connected_by_github_login}`
                              : 'that account'}
                            .
                          </strong>{' '}
                          A connect invite works for whoever opens the link, so a forwarded or
                          leaked one can reach someone else&apos;s GitHub account. Rejecting frees
                          the slot and leaves nothing behind; the invite list below shows who used
                          which invite.
                        </p>
                        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                          <button onClick={handleConfirmConnection} className="btn btn-primary" disabled={githubBusy}>
                            Confirm
                          </button>
                          <button onClick={handleRejectConnection} className="btn btn-danger" disabled={githubBusy}>
                            Reject
                          </button>
                        </div>
                      </div>
                    )}

                    {githubConnection.status !== 'pending_confirmation' && (
                      <div style={{ marginTop: '1.5rem' }}>
                        <button onClick={handleDisconnectGithub} className="btn btn-danger" disabled={githubBusy}>
                          Disconnect GitHub
                        </button>
                        <p style={{ fontSize: '0.825rem', marginTop: '0.75rem', marginBottom: 0 }}>
                          Disconnecting removes every repository link in this directory. The owner
                          can also change the shared repositories, or remove the installation, on
                          GitHub — that applies here immediately.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>

              {githubConnection?.status === 'active' && (
                <div className="card">
                  <h2>Linked Repositories</h2>
                  <p style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-muted)' }}>
                    Choose which of the shared repositories the bot may read, and where.
                    Linking a repository to a group lets <strong>every member of that group</strong>
                    {' '}reach its code through the bot.
                  </p>

                  {repoLoadError && (
                    <div className="alert alert-error" style={{ marginTop: '1rem' }}>{repoLoadError}</div>
                  )}

                  {repoLoading && !repoLoadError && (
                    <p style={{ fontSize: '0.9rem', marginTop: '1rem' }}>Reading the shared repositories…</p>
                  )}

                  <RepoLinkSection
                    key={`entity-${repoLinks.filter((l) => !l.group_id).map((l) => l.repo_id).join('-')}`}
                    entityId={entityId}
                    repositories={repoOptions}
                    links={repoLinks.filter((l) => !l.group_id && !l.thread_id)}
                    groupId={null}
                    heading="Every group in this directory"
                    description="For shared library repositories. Reachable from every group and topic here."
                    onSaved={loadRepoData}
                  />

                  {linkedGroups.length === 0 ? (
                    <p style={{ fontSize: '0.9rem', marginTop: '1.5rem' }}>
                      No Telegram groups are linked yet — bind one under <strong>Linked Groups</strong> to
                      give it repositories of its own.
                    </p>
                  ) : (
                    linkedGroups.map((g) => (
                      <RepoLinkSection
                        key={`group-${g.id}-${repoLinks
                          .filter((l) => l.group_id === g.id && !l.thread_id)
                          .map((l) => l.repo_id)
                          .join('-')}`}
                        entityId={entityId}
                        repositories={repoOptions}
                        links={repoLinks.filter((l) => l.group_id === g.id && !l.thread_id)}
                        groupId={g.id}
                        heading={g.display_name || `Group ${g.telegram_chat_id}`}
                        description="Reachable from every topic in this group, unless a topic is pinned to fewer."
                        onSaved={loadRepoData}
                      />
                    ))
                  )}

                  {repoLinks.some((l) => l.thread_id) && (
                    <div style={{ marginTop: '2rem' }}>
                      <h3 style={{ fontSize: '1rem', marginBottom: '0.35rem' }}>Topic pins</h3>
                      <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                        Topics pinned to a subset of their group's repositories. Pins can only narrow,
                        never add. Setting them from here, and with <code>/repos</code> in chat, comes next.
                      </p>
                      <div className="table-container" style={{ marginTop: '1rem' }}>
                        <table>
                          <thead>
                            <tr>
                              <th>Group</th>
                              <th>Topic</th>
                              <th>Repository id</th>
                              <th>Pinned</th>
                            </tr>
                          </thead>
                          <tbody>
                            {repoLinks
                              .filter((l) => l.thread_id)
                              .map((l) => (
                                <tr key={l.id}>
                                  <td>{l.group_name || '—'}</td>
                                  <td>{l.thread_name || `#${l.telegram_thread_id ?? '?'}`}</td>
                                  <td>
                                    <code>
                                      {repoOptions.find((r) => r.id === l.repo_id)?.fullName ?? l.repo_id}
                                    </code>
                                  </td>
                                  <td>{new Date(l.created_at).toLocaleString()}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {inviteLink && (
                <div className="card">
                  <h2>Connect Invite</h2>
                  <p style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-muted)' }}>
                    Send this link to the person who owns the GitHub account. It works once, expires
                    in 24 hours, and is shown only now.
                  </p>
                  <div
                    onClick={handleCopyInvite}
                    className="code-copy-box"
                    style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px dashed rgba(255, 255, 255, 0.15)',
                      borderRadius: '6px',
                      padding: '1.25rem',
                      marginTop: '1.25rem',
                      cursor: 'pointer',
                      position: 'relative',
                      wordBreak: 'break-all',
                    }}
                  >
                    <div style={{ fontFamily: 'monospace', fontSize: '0.95rem', color: '#60a5fa' }}>
                      {inviteLink}
                    </div>
                    <span style={{ position: 'absolute', right: '12px', top: '12px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {inviteCopied ? 'Copied!' : 'Click to Copy'}
                    </span>
                  </div>
                </div>
              )}

              {/* Shown whichever state the connection is in: an invite that is no longer
                  usable is still worth revoking if the link leaked. */}
              {githubInvites.length > 0 && (
                <div className="card">
                  <h2>Connect Invites</h2>
                  <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                    Who used which invite. If an invite was used by a GitHub account you do not
                    recognise, reject the connection above and revoke any invite still pending.
                  </p>
                  <div className="table-container" style={{ marginTop: '1.25rem' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Issued</th>
                          <th>State</th>
                          <th>Used by</th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {githubInvites.map((inv) => {
                          const state = inviteState(inv);
                          return (
                            <tr key={inv.id}>
                              <td>{new Date(inv.created_at).toLocaleString()}</td>
                              <td>
                                <span className={`badge badge-${state === 'pending' ? 'pending' : 'active'}`}>
                                  {state}
                                </span>
                                {state === 'pending' && (
                                  <span style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
                                    &nbsp;until {new Date(inv.expires_at).toLocaleString()}
                                  </span>
                                )}
                              </td>
                              <td>
                                {inv.completed_by_github_login ? (
                                  <>
                                    <strong>@{inv.completed_by_github_login}</strong>
                                    {inv.consumed_at && (
                                      <span style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
                                        &nbsp;on {new Date(inv.consumed_at).toLocaleString()}
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <span style={{ color: 'var(--text-muted)' }}>—</span>
                                )}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                {state === 'pending' ? (
                                  <button
                                    onClick={() => handleRevokeInvite(inv.id)}
                                    className="btn btn-danger"
                                    style={{ padding: '0.4rem 0.8rem', fontSize: '0.825rem' }}
                                  >
                                    Revoke
                                  </button>
                                ) : (
                                  <span style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
