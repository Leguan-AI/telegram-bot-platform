'use client';

import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_NAME_LENGTH,
  contextByteLength,
  decodeContextFile,
  documentNameFromFile,
  contextErrorMessage,
  ContextFileError,
} from '@/lib/contextFile';
import {
  CONTEXT_BUDGET_BYTES,
  contextBudgetFraction,
  contextBudgetLevel,
  contextBudgetWarning,
  effectiveContextBytes,
  formatContextBytes,
  type BudgetDoc,
} from '@/lib/contextBudget';

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

const formatKb = formatContextBytes;

/**
 * A name no other document in the same scope is using. The database enforces this too
 * (`duplicate_doc_name`); doing it here as well means an uploaded file never bounces off a
 * name clash the admin never chose.
 */
function uniqueName(base: string, taken: ContextDoc[], ignoreDocId?: string): string {
  const used = new Set(
    taken.filter((d) => d.doc_id !== ignoreDocId).map((d) => d.display_name.toLowerCase())
  );
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

interface ContextBudgetMeterProps {
  /** Bytes the bot reads for an answer in this scope today. */
  currentBytes: number;
  /** Bytes if the draft in the editor were saved; null when there is no draft to project. */
  projectedBytes: number | null;
  /** What the total covers, e.g. "this entity's documents" — shown after "Total context". */
  coverage: string;
}

/**
 * Running total of the context the bot reads for one answer, against the advisory budget in
 * lib/contextBudget.ts, with a warning as it approaches or passes it. Advisory only: nothing here
 * (or on the server) refuses a save.
 */
export function ContextBudgetMeter({ currentBytes, projectedBytes, coverage }: ContextBudgetMeterProps) {
  const shownBytes = projectedBytes ?? currentBytes;
  const level = contextBudgetLevel(shownBytes);
  const warning = contextBudgetWarning(shownBytes);
  const colour = level === 'over' ? 'var(--danger)' : level === 'warn' ? '#fbbf24' : 'var(--primary, #2563eb)';
  return (
    <div style={{ marginBottom: '1rem' }} data-budget-level={level}>
      <div className="context-meta" style={{ marginBottom: '0.35rem' }}>
        <span>
          <strong>Total context</strong> ({coverage}): {formatKb(currentBytes)} of {formatKb(CONTEXT_BUDGET_BYTES)} recommended
        </span>
        {projectedBytes !== null && projectedBytes !== currentBytes && (
          <span>After saving this draft: {formatKb(projectedBytes)}</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Context size against the recommended budget"
        aria-valuemin={0}
        aria-valuemax={CONTEXT_BUDGET_BYTES}
        aria-valuenow={Math.min(shownBytes, CONTEXT_BUDGET_BYTES)}
        style={{ height: 6, borderRadius: 3, background: 'rgba(148, 163, 184, 0.25)', overflow: 'hidden' }}
      >
        <div
          style={{ width: `${contextBudgetFraction(shownBytes) * 100}%`, height: '100%', background: colour }}
        />
      </div>
      {warning && (
        <div className={`alert ${level === 'over' ? 'alert-error' : 'alert-warning'}`} style={{ marginTop: '0.5rem' }}>
          {warning}
        </div>
      )}
    </div>
  );
}

interface ContextDocTableProps {
  docs: ContextDoc[];
  showGroup?: boolean;
  /** Omitted for a read-only table; present when the viewer may edit context here. */
  onEdit?: (doc: ContextDoc) => void;
  onDelete?: (doc: ContextDoc) => void;
  editingDocId?: string | null;
  busyDocId?: string | null;
}

/** The documents the bot can answer from, with per-row actions when the viewer may edit. */
export function ContextDocTable({
  docs,
  showGroup = false,
  onEdit,
  onDelete,
  editingDocId = null,
  busyDocId = null,
}: ContextDocTableProps) {
  const withActions = Boolean(onEdit || onDelete);

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
            {withActions && <th style={{ textAlign: 'right' }}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr
              key={`${d.doc_id}-${d.group_id ?? 'e'}-${d.scope}`}
              style={d.doc_id === editingDocId ? { background: 'rgba(37, 99, 235, 0.12)' } : undefined}
            >
              <td><strong>{d.display_name}</strong></td>
              <td>{appliesTo(d, showGroup)}</td>
              <td>{sourceLabel(d)}</td>
              <td>{formatKb(d.size_bytes)}</td>
              <td>{new Date(d.updated_at).toLocaleString()}</td>
              {withActions && (
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {onEdit && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.825rem' }}
                      onClick={() => onEdit(d)}
                      disabled={busyDocId === d.doc_id}
                    >
                      {d.doc_id === editingDocId ? 'Editing' : 'Edit'}
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.825rem', marginLeft: '0.5rem' }}
                      onClick={() => onDelete(d)}
                      disabled={busyDocId === d.doc_id}
                    >
                      {busyDocId === d.doc_id ? 'Working…' : 'Delete'}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ContextDocManagerProps {
  entityId: string;
  /** null = documents that apply to the whole entity; otherwise this group's documents. */
  groupId: string | null;
  canEdit: boolean;
  /** Every document to list here. Topic documents of a group belong in its group list. */
  docs: ContextDoc[];
  /** Re-reads the document list after a create, edit or delete. */
  onChanged: () => void | Promise<void>;
  showGroup?: boolean;
  /**
   * Documents this scope inherits and the bot reads alongside its own: a group's answers also
   * carry the entity-wide documents. Omit for the entity itself.
   */
  inheritedDocs?: ContextDoc[];
}

/**
 * Add, edit and delete the documents of one scope.
 *
 * A scope holds as many documents as the admin wants (`create_context_doc`), so the box above
 * the list is a draft of a *new* document, not an editor bound to the scope's one document:
 * saving clears it and the document appears below, and uploading a file adds a document of its
 * own without touching whatever is in the box. Editing an existing document loads it into the
 * same box, which returns to the empty "add" state once the change is saved.
 */
export function ContextDocManager({
  entityId,
  groupId,
  canEdit,
  docs,
  onChanged,
  showGroup = false,
  inheritedDocs = [],
}: ContextDocManagerProps) {
  // null = composing a new document; otherwise the doc_id being edited.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState<ContextDoc | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  // Exact string returned by the server; sent back untouched as the overwrite check
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  // What the editor held when it was loaded (empty for a new document), to tell a draft with
  // unsaved changes from an untouched one.
  const [baseline, setBaseline] = useState({ name: '', content: '' });

  const [saving, setSaving] = useState(false);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  // Documents a new one would sit beside — a group's topic documents live in another scope.
  const addScope: ContextDoc['scope'] = groupId === null ? 'entity' : 'group';
  const sameScopeDocs = docs.filter((d) => d.scope === addScope);

  const bytes = contextByteLength(content);
  const tooLarge = bytes > MAX_CONTEXT_BYTES;
  const canSave = canEdit && !saving && !tooLarge && content.trim() !== '' && name.trim() !== '';

  const isDirty = name !== baseline.name || content !== baseline.content;

  // The total the bot would read for an answer here, now and with the draft saved. An edit swaps
  // the document's size for the draft's; a new document adds the draft to the scope.
  const currentBytes = effectiveContextBytes(inheritedDocs, docs);
  const hasDraft = content.trim() !== '';
  let projectedBytes: number | null = null;
  if (hasDraft) {
    const draftSize = contextByteLength(content);
    const draftDocs: BudgetDoc[] = editingId
      ? docs.map((d) => (d.doc_id === editingId ? { ...d, size_bytes: draftSize } : d))
      : [...docs, { doc_id: 'draft', scope: addScope, thread_name: null, size_bytes: draftSize }];
    projectedBytes = effectiveContextBytes(inheritedDocs, draftDocs);
  }

  const resetDraft = () => {
    setEditingId(null);
    setEditingSource(null);
    setName('');
    setContent('');
    setUpdatedAt(null);
    setBaseline({ name: '', content: '' });
  };

  const handleCancel = () => {
    if (isDirty && !confirm('Discard your unsaved changes to this document?')) return;
    resetDraft();
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const finalName = name.trim();
      if (editingId) {
        const { error: rpcErr } = await supabase.rpc('update_context_doc', {
          p_entity: entityId,
          p_doc: editingId,
          p_name: finalName,
          p_content: content,
          p_expected_updated_at: updatedAt,
        });
        if (rpcErr) throw rpcErr;
        setSuccess(`Saved “${finalName}”. The bot will use it on its next answer.`);
      } else {
        const { error: rpcErr } = await supabase.rpc('create_context_doc', {
          p_entity: entityId,
          p_group: groupId,
          p_name: finalName,
          p_content: content,
        });
        if (rpcErr) throw rpcErr;
        setSuccess(`Added “${finalName}”. It is listed below and the bot will use it on its next answer.`);
      }
      resetDraft();
      await onChanged();
    } catch (err: any) {
      setError(contextErrorMessage(err.message));
    } finally {
      setSaving(false);
    }
  };

  /** Upload adds a document straight away; the draft in the box is never replaced. */
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const text = decodeContextFile(await file.arrayBuffer());
      const docName = uniqueName(documentNameFromFile(file.name) || 'uploaded-document', sameScopeDocs);
      const { error: rpcErr } = await supabase.rpc('create_context_doc', {
        p_entity: entityId,
        p_group: groupId,
        p_name: docName,
        p_content: text,
      });
      if (rpcErr) throw rpcErr;
      setSuccess(`Added “${docName}” from ${file.name}. It is listed below.`);
      await onChanged();
    } catch (err: any) {
      setError(err instanceof ContextFileError ? err.message : contextErrorMessage(err.message));
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (doc: ContextDoc) => {
    // The editor holds one draft. Loading a document into it would throw away unsaved work
    // without a word, so ask first (also covers re-clicking the document already open).
    if (
      isDirty &&
      !confirm(
        `You have unsaved changes in the editor. Discard them and open “${doc.display_name}”?`
      )
    ) {
      return;
    }
    setError('');
    setSuccess('');
    setBusyDocId(doc.doc_id);
    try {
      const { data, error: rpcErr } = await supabase.rpc('get_context_doc', {
        p_entity: entityId,
        p_doc: doc.doc_id,
      });
      if (rpcErr) throw rpcErr;
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) throw new Error('doc_not_found');
      setEditingId(doc.doc_id);
      setEditingSource(doc);
      const loadedName = row.display_name ?? doc.display_name;
      const loadedContent = row.content ?? '';
      setName(loadedName);
      setContent(loadedContent);
      setBaseline({ name: loadedName, content: loadedContent });
      setUpdatedAt(row.updated_at ?? null);
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err: any) {
      setError(contextErrorMessage(err.message));
    } finally {
      setBusyDocId(null);
    }
  };

  const handleDelete = async (doc: ContextDoc) => {
    const where = appliesTo(doc, showGroup).toLowerCase();
    if (
      !confirm(
        `Delete “${doc.display_name}”?\n\n` +
          `Added via ${sourceLabel(doc)}, applies to ${where}. The bot stops using it on its next ` +
          `answer. This cannot be undone.`
      )
    ) {
      return;
    }
    setError('');
    setSuccess('');
    setBusyDocId(doc.doc_id);
    try {
      const { data, error: rpcErr } = await supabase.rpc('delete_context_doc', {
        p_entity: entityId,
        p_doc: doc.doc_id,
      });
      if (rpcErr) throw rpcErr;
      setSuccess(
        data === false
          ? `“${doc.display_name}” had already been removed.`
          : `Deleted “${doc.display_name}”.`
      );
      if (editingId === doc.doc_id) resetDraft();
      await onChanged();
    } catch (err: any) {
      setError(contextErrorMessage(err.message));
    } finally {
      setBusyDocId(null);
    }
  };

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <ContextBudgetMeter
        currentBytes={currentBytes}
        projectedBytes={canEdit ? projectedBytes : null}
        coverage={
          groupId === null
            ? 'all entity-wide documents, read in every group'
            : 'entity-wide, this group’s and its largest topic’s documents'
        }
      />

      {canEdit && (
        <div ref={editorRef}>
          <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>
            {editingId ? `Edit “${editingSource?.display_name ?? name}”` : 'Add a document'}
          </h3>

          {editingId && editingSource?.source_type === 'push' && (
            <div className="alert alert-warning">
              This document was pushed from a Telegram chat. Pushing the same message again will
              overwrite your changes here.
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor={`doc-name-${groupId ?? 'entity'}`}>
              Document name
            </label>
            <input
              id={`doc-name-${groupId ?? 'entity'}`}
              type="text"
              className="form-control"
              value={name}
              maxLength={MAX_CONTEXT_NAME_LENGTH}
              placeholder="e.g. pricing-and-plans"
              onChange={(e) => {
                setName(e.target.value);
                setSuccess('');
              }}
              disabled={saving}
            />
          </div>

          <textarea
            className="form-control context-textarea"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setSuccess('');
            }}
            placeholder="Write or paste the background the bot should answer from (Markdown or plain text)..."
            disabled={saving}
            spellCheck
          />

          <div className="context-meta">
            <span style={{ color: tooLarge ? 'var(--danger)' : undefined }}>
              {formatKb(bytes)} / {MAX_CONTEXT_BYTES / 1024} KB
            </span>
            <span>
              {editingId && updatedAt
                ? `Last saved ${new Date(updatedAt).toLocaleString()}`
                : 'New document'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!canSave}>
              {saving ? 'Saving...' : editingId ? 'Save changes' : 'Add document'}
            </button>
            {editingId && (
              <button type="button" className="btn btn-secondary" onClick={handleCancel} disabled={saving}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fileInput.current?.click()}
              disabled={saving}
            >
              Upload .md / .txt as a new document
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".md,.markdown,.txt,text/plain,text/markdown"
              onChange={handleFile}
              style={{ display: 'none' }}
            />
          </div>
        </div>
      )}

      <div style={{ marginTop: canEdit ? '2rem' : 0 }}>
        <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>
          Documents {groupId === null ? 'that apply to the whole entity' : 'for this group'}
        </h3>
        <ContextDocTable
          docs={docs}
          showGroup={showGroup}
          onEdit={canEdit ? handleEdit : undefined}
          onDelete={canEdit ? handleDelete : undefined}
          editingDocId={editingId}
          busyDocId={busyDocId}
        />
      </div>

      {!canEdit && (
        <p style={{ margin: '1rem 0 0', fontSize: '0.85rem' }}>
          Only the owner, admins and editors can add or change context documents.
        </p>
      )}
    </div>
  );
}
