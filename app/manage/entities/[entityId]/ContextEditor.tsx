'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  MAX_CONTEXT_BYTES,
  contextByteLength,
  decodeContextFile,
  contextErrorMessage,
  ContextFileError,
} from '@/lib/contextFile';

export interface ContextDoc {
  doc_id: string;
  display_name: string;
  scope: 'entity' | 'group' | 'topic';
  group_id: string | null;
  group_name: string | null;
  thread_name: string | null;
  source_type: string;
  managed: boolean;
  size_bytes: number;
  updated_at: string;
}

function sourceLabel(doc: ContextDoc): string {
  if (doc.managed) return 'Dashboard';
  if (doc.source_type === 'push') return 'Chat (/push)';
  return 'Manual (SQL)';
}

function appliesTo(doc: ContextDoc, showGroup: boolean): string {
  if (doc.scope === 'entity') return 'Whole entity';
  if (doc.scope === 'group') return showGroup ? `Group: ${doc.group_name ?? 'unknown'}` : 'Whole group';
  const topic = doc.thread_name ? `Topic: ${doc.thread_name}` : 'One topic';
  return showGroup ? `${topic} (${doc.group_name ?? 'unknown'})` : topic;
}

const formatKb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** Read-only list of documents the bot can answer from. */
export function ContextDocTable({ docs, showGroup = false }: { docs: ContextDoc[]; showGroup?: boolean }) {
  if (docs.length === 0) {
    return <p style={{ margin: 0, fontSize: '0.9rem' }}>No documents yet.</p>;
  }
  return (
    <div className="table-container">
      <table>
        <thead>
          <tr>
            <th>Document</th>
            <th>Applies to</th>
            <th>Added via</th>
            <th>Size</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={`${d.doc_id}-${d.group_id ?? 'e'}-${d.scope}`}>
              <td><strong>{d.display_name}</strong></td>
              <td>{appliesTo(d, showGroup)}</td>
              <td>{sourceLabel(d)}</td>
              <td>{formatKb(d.size_bytes)}</td>
              <td>{new Date(d.updated_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ContextEditorProps {
  entityId: string;
  /** null = entity-wide document; otherwise the group's document */
  groupId: string | null;
  canEdit: boolean;
  onSaved?: () => void;
}

/** Single-document editor for the dashboard-managed context of one scope. */
export function ContextEditor({ entityId, groupId, canEdit, onSaved }: ContextEditorProps) {
  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState('');
  // Exact string returned by the server; sent back untouched as the overwrite check
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflict, setConflict] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    setConflict(false);
    try {
      const { data, error: rpcErr } = await supabase.rpc('get_managed_context', {
        p_entity: entityId,
        p_group: groupId,
      });
      if (rpcErr) throw rpcErr;
      const row = Array.isArray(data) ? data[0] : null;
      setContent(row?.content ?? '');
      setBaseline(row?.content ?? '');
      setUpdatedAt(row?.updated_at ?? null);
    } catch (err: any) {
      setError(contextErrorMessage(err.message));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, groupId]);

  const bytes = contextByteLength(content);
  const tooLarge = bytes > MAX_CONTEXT_BYTES;
  const dirty = content !== baseline;
  const canSave = canEdit && dirty && !saving && !tooLarge && content.trim() !== '';

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    setConflict(false);
    try {
      const { data, error: rpcErr } = await supabase.rpc('save_managed_context', {
        p_entity: entityId,
        p_group: groupId,
        p_content: content,
        p_expected_updated_at: updatedAt,
      });
      if (rpcErr) throw rpcErr;
      const trimmed = content.trim();
      setContent(trimmed);
      setBaseline(trimmed);
      setUpdatedAt(data as string);
      setSuccess('Saved. The bot will use this on its next answer.');
      onSaved?.();
    } catch (err: any) {
      setConflict(String(err.message ?? '').includes('context_conflict'));
      setError(contextErrorMessage(err.message));
    } finally {
      setSaving(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setSuccess('');
    try {
      const text = decodeContextFile(await file.arrayBuffer());
      if (content.trim() && !confirm(`Replace the current text with the contents of ${file.name}?`)) return;
      setContent(text);
    } catch (err: any) {
      setError(err instanceof ContextFileError ? err.message : 'Could not read that file.');
    }
  };

  if (loading) {
    return <p style={{ margin: 0 }}>Loading context...</p>;
  }

  return (
    <div>
      {error && (
        <div className="alert alert-error" style={{ flexWrap: 'wrap' }}>
          <span>{error}</span>
          {conflict && (
            <button type="button" className="btn btn-secondary" onClick={load}>
              Reload latest
            </button>
          )}
        </div>
      )}
      {success && <div className="alert alert-success">{success}</div>}

      <textarea
        className="form-control context-textarea"
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setSuccess('');
        }}
        readOnly={!canEdit}
        placeholder={
          canEdit
            ? 'Write or paste the background the bot should answer from (Markdown or plain text)...'
            : 'No context has been added yet.'
        }
        spellCheck
      />

      <div className="context-meta">
        <span style={{ color: tooLarge ? 'var(--danger)' : undefined }}>
          {formatKb(bytes)} / {MAX_CONTEXT_BYTES / 1024} KB
        </span>
        <span>{updatedAt ? `Last saved ${new Date(updatedAt).toLocaleString()}` : 'Not saved yet'}</span>
      </div>

      {canEdit ? (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!canSave}>
            {saving ? 'Saving...' : 'Save context'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => fileInput.current?.click()} disabled={saving}>
            Upload .md / .txt
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.txt,text/plain,text/markdown"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
        </div>
      ) : (
        <p style={{ margin: '1rem 0 0', fontSize: '0.85rem' }}>
          Only the owner, admins and editors can edit context.
        </p>
      )}
    </div>
  );
}
