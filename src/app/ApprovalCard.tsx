import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  FileText,
  Globe,
  Plug,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import type { ApprovalExplanation, ToolApproval } from './CodexQuestions';

/**
 * Line breaks after the top-level `&&`, `||` and `;` of a one-line shell
 * command, so a chain reads as its steps. Quotes, `$( … )`, backticks and
 * escapes are respected; anything multi-line (heredocs, scripts) is shown as
 * written. Display only: copying always takes the original text.
 */
export const formatShellCommand = (command: string): string => {
  if (command.includes('\n') || command.includes('<<')) return command;
  const lines: string[] = [];
  let line = '';
  // Open quotes and parentheses, innermost last.
  const stack: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1] ?? '';
    const top = stack[stack.length - 1];
    if (char === '\\' && top !== "'") {
      line += char + next;
      i++;
      continue;
    }
    if (top === "'" || top === '`') {
      if (char === top) stack.pop();
      line += char;
      continue;
    }
    if (char === '$' && next === '(') {
      stack.push('(');
      line += '$(';
      i++;
      continue;
    }
    if (top === '"') {
      if (char === '"') stack.pop();
      line += char;
      continue;
    }
    if (char === '"' || char === "'" || char === '`' || char === '(') stack.push(char);
    else if (char === ')' && top === '(') stack.pop();
    if (!stack.length && ((char === '&' && next === '&') || (char === '|' && next === '|'))) {
      lines.push(`${line.trimEnd()} ${char}${next}`);
      line = '';
      i++;
      continue;
    }
    if (char === ';' && next === ';') {
      line += ';;';
      i++;
      continue;
    }
    if (!stack.length && char === ';') {
      lines.push(`${line.trimEnd()};`);
      line = '';
      continue;
    }
    line += char;
  }
  if (line.trim()) lines.push(line);
  return lines.map((part, index) => (index === 0 ? part.trim() : `  ${part.trim()}`)).join('\n');
};

const RISK_LABEL: Record<NonNullable<ApprovalExplanation['risk']>, string> = {
  'read-only': 'Only reads',
  changes: 'Makes changes',
  destructive: 'Hard to undo',
};

const ToolIcon = ({ approval }: { approval: ToolApproval }) => {
  const size = 15;
  if (approval.command) return <SquareTerminal size={size} />;
  if (approval.url) return <Globe size={size} />;
  if (approval.path) return <FileText size={size} />;
  if (approval.toolName.startsWith('mcp__')) return <Plug size={size} />;
  return <Wrench size={size} />;
};

const toolLabel = (toolName: string) => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return mcp ? `${mcp[1].replace(/^claude_ai_/, '')} · ${mcp[2]}` : toolName;
};

const COLLAPSED_LINES = 6;

const CodeBlock = ({ label, text, meta }: { label: string; text: string; meta?: string }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const display = label === 'Command' ? formatShellCommand(text) : text;
  const lineCount = display.split('\n').length;
  const long = lineCount > COLLAPSED_LINES || display.length > 600;
  return (
    <div className="approval-code">
      <div className="approval-code-head">
        <span>{label}</span>
        {meta && <span className="approval-code-meta" title={meta}>{meta}</span>}
        <button
          type="button"
          className="approval-code-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          aria-label={`Copy ${label.toLowerCase()}`}
          title="Copy"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre className={long && !expanded ? 'collapsed' : undefined}>{display}</pre>
      {long && (
        <button type="button" className="approval-code-toggle" onClick={() => setExpanded((value) => !value)}>
          <ChevronDown size={12} className={expanded ? 'flipped' : undefined} />
          {expanded ? 'Show less' : `Show all${lineCount > COLLAPSED_LINES ? ` ${lineCount} lines` : ''}`}
        </button>
      )}
    </div>
  );
};

export type ExplainApproval = (approval: ToolApproval, key: string) => Promise<ApprovalExplanation | null>;

/**
 * A tool call waiting for the user's OK: who wants to do what and why, a
 * plain-English account of what running it will do, the exact call, and
 * one-click Allow / Deny.
 */
export const ApprovalCard = ({
  approval,
  explainKey,
  explain,
  sending,
  error,
  onAnswer,
}: {
  approval: ToolApproval;
  explainKey: string;
  explain?: ExplainApproval;
  sending: 'Allow once' | 'Deny' | null;
  error: string;
  onAnswer: (answer: 'Allow once' | 'Deny') => void;
}) => {
  const [explanation, setExplanation] = useState<ApprovalExplanation | null>(null);
  const [explaining, setExplaining] = useState(Boolean(explain));
  useEffect(() => {
    if (!explain) {
      setExplaining(false);
      return undefined;
    }
    let live = true;
    setExplaining(true);
    explain(approval, explainKey)
      .then((result) => {
        if (live) setExplanation(result);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setExplaining(false);
      });
    return () => {
      live = false;
    };
    // The key identifies the request; the approval object is re-created on
    // every poll and must not restart the explanation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explainKey, Boolean(explain)]);

  const risk = explanation?.risk ?? null;
  return (
    <div className={`codex-question-card approval-card${risk ? ` risk-${risk}` : ''}`}>
      <div className="approval-head">
        <span className="approval-icon" aria-hidden="true">
          <ToolIcon approval={approval} />
        </span>
        <div className="approval-heading">
          <div className="approval-title">{approval.title}</div>
          {approval.purpose && <div className="approval-purpose">{approval.purpose}</div>}
        </div>
        <span className="approval-tool-chip" title={approval.toolName}>
          {toolLabel(approval.toolName)}
        </span>
      </div>
      <div className="approval-body">
        {(explaining || explanation) && (
          <section className="approval-explain" aria-live="polite">
            <div className="approval-section-label">
              <Sparkles size={12} aria-hidden="true" />
              <span>What it will do</span>
              {risk && <span className={`approval-risk risk-${risk}`}>{RISK_LABEL[risk]}</span>}
            </div>
            {explanation ? (
              <>
                <p>{explanation.summary}</p>
                {explanation.partial && (
                  <p className="approval-explain-partial">This call is long, so only its first part was explained. Check the rest below.</p>
                )}
                {explanation.steps.length > 0 && (
                  <ol>
                    {explanation.steps.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                )}
              </>
            ) : (
              <div className="approval-explain-loading" aria-label="Explaining this call">
                <span />
                <span />
              </div>
            )}
          </section>
        )}
        {approval.reason && (
          <div className="approval-reason">
            <ShieldAlert size={14} aria-hidden="true" />
            <div>
              <strong>Why you're being asked</strong>
              <span>{approval.reason}</span>
            </div>
          </div>
        )}
        {approval.command && <CodeBlock label="Command" text={approval.command} />}
        {approval.path && <CodeBlock label="File" text={approval.path} />}
        {approval.url && <CodeBlock label="URL" text={approval.url} />}
        {approval.blockedPath && approval.blockedPath !== approval.path && (
          <CodeBlock label="Outside the allowed folders" text={approval.blockedPath} />
        )}
        {approval.input && <CodeBlock label="Details" text={approval.input} />}
      </div>
      <div className="codex-question-footer approval-footer">
        {error ? <p role="alert">{error}</p> : <span className="approval-footnote">Applies to this call only</span>}
        <button type="button" className="approval-deny" disabled={sending !== null} onClick={() => onAnswer('Deny')}>
          {sending === 'Deny' ? 'Denying…' : 'Deny'}
        </button>
        <button
          type="button"
          className="codex-question-submit approval-allow"
          disabled={sending !== null}
          onClick={() => onAnswer('Allow once')}
        >
          {sending === 'Allow once' ? 'Allowing…' : 'Allow once'}
        </button>
      </div>
    </div>
  );
};
