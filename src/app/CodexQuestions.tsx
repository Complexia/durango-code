import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, MessageCircleQuestion } from 'lucide-react';
import { ApprovalCard, type ExplainApproval } from './ApprovalCard';

/** A tool call waiting for approval, as the approval card shows it (main/approval-explainer.js). */
export type ToolApproval = {
  toolName: string;
  title: string;
  /** The agent's own one-line reason, e.g. Bash's description. */
  purpose?: string;
  /** Why the agent's harness asked instead of running it. */
  reason?: string;
  blockedPath?: string;
  command?: string;
  path?: string;
  url?: string;
  /** The rest of the tool input, as JSON. */
  input?: string;
};

export type ApprovalExplanation = {
  summary: string;
  steps: string[];
  risk: 'read-only' | 'changes' | 'destructive' | null;
  /** The call was too long to explain whole: only its start was read. */
  partial?: boolean;
};

export type CodexQuestionRequest = {
  providerId?: 'codex' | 'claude';
  /** Astra's request_user_input_async: answered with an ordinary steered user message. */
  async?: boolean;
  detail?: string;
  /** Set on tool approvals (one Allow once / Deny question): rendered as the approval card. */
  approval?: ToolApproval;
  runId: string;
  requestId: string | number;
  threadId: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isSecret?: boolean;
    multiSelect?: boolean;
    allowCustom?: boolean;
    options?: Array<{ label: string; description: string }> | null;
  }>;
};

type AsyncAnswerHandler = (request: CodexQuestionRequest, answers: Record<string, string[]>) => Promise<boolean>;

/**
 * A thread that runs on another machine (remote control): its questions are
 * read from and answered on that machine, which handles them exactly as its
 * own question card would (async ones included).
 */
export type RemoteQuestionSource = { machineId: string; machineName: string; threadId: string };

export const asyncAnswerText = (request: CodexQuestionRequest, answers: Record<string, string[]>) =>
  request.questions.map((question) => `${question.question}\n${answers[question.id].join(', ')}`).join('\n\n');

/**
 * The free-text answer. Secrets stay a single-line password input; everything
 * else is a textarea that grows with its text like the composer (up to the CSS
 * max-height, then scrolls). Enter sends, Shift+Enter adds a line.
 */
const AnswerField = ({
  id,
  secret,
  placeholder,
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  id: string;
  secret?: boolean;
  placeholder: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the borders; add them back so the last line isn't clipped.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSubmit();
    }
  };
  if (secret) {
    return (
      <input
        id={id}
        type="password"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
    );
  }
  return (
    <textarea
      ref={textareaRef}
      id={id}
      rows={1}
      autoComplete="off"
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
    />
  );
};

const QuestionCard = ({
  request,
  refresh,
  onAsyncAnswer,
  remote,
  explain,
}: {
  request: CodexQuestionRequest;
  refresh: () => void;
  onAsyncAnswer?: AsyncAnswerHandler;
  remote?: RemoteQuestionSource;
  explain?: ExplainApproval;
}) => {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const answerFor = (id: string) => [...(answers[id] ?? []), ...(customAnswers[id]?.trim() ? [customAnswers[id]] : [])];
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const complete = request.questions.every((question) => answerFor(question.id).length > 0);

  const [approvalAnswer, setApprovalAnswer] = useState<'Allow once' | 'Deny' | null>(null);
  const submit = async (override?: Record<string, string[]>) => {
    if (sending || (!override && !complete)) return;
    setSending(true);
    setError('');
    try {
      const answers = override ?? Object.fromEntries(request.questions.map((question) => [question.id, answerFor(question.id)]));
      if (remote) {
        const result = await window.orion?.remoteAnswerQuestion?.({
          machineId: remote.machineId,
          threadId: remote.threadId,
          runId: request.runId,
          requestId: request.requestId,
          answers,
        });
        if (!result?.ok) setError(result?.error ?? `Could not reach ${remote.machineName}. Try again.`);
        refresh();
        return;
      }
      if (request.async && !onAsyncAnswer) throw new Error('No async answer handler');
      const send = request.providerId === 'claude' ? window.orion?.answerClaudeQuestions : window.orion?.answerCodexQuestions;
      // The owner captures cancellation before any async submission work.
      const accepted = request.async
        ? await onAsyncAnswer?.(request, answers)
        : await send?.(request.runId, request.requestId, answers);
      if (!accepted) setError(request.async ? 'Could not send your answers. Try again.' : 'This question is no longer waiting for an answer.');
      refresh();
    } catch {
      setError('Could not send your answers. Try again.');
    } finally {
      setSending(false);
      setApprovalAnswer(null);
    }
  };

  const approvalQuestion = request.questions.length === 1 ? request.questions[0] : null;
  if (request.approval && approvalQuestion && !request.async) {
    return (
      <ApprovalCard
        approval={request.approval}
        explainKey={`${remote?.machineId ?? 'local'}:${request.providerId ?? 'codex'}:${request.runId}:${request.requestId}`}
        explain={explain}
        sending={approvalAnswer}
        error={error}
        onAnswer={(answer) => {
          if (sending) return;
          setApprovalAnswer(answer);
          void submit({ [approvalQuestion.id]: [answer] });
        }}
      />
    );
  }

  return (
    <div className="codex-question-card">
      <div className="codex-question-body">
        {request.detail && <pre className="agent-request-detail">{request.detail}</pre>}
        {request.questions.map((question) => (
          <div key={question.id} className="codex-question">
            <div className="codex-question-header">
              <MessageCircleQuestion size={13} aria-hidden="true" />
              <span>{question.header}</span>
              {question.multiSelect && <small>Choose any</small>}
            </div>
            <label htmlFor={`codex-question-${request.requestId}-${question.id}`}>{question.question}</label>
            {!!question.options?.length && !question.isSecret && (
              <div className="codex-question-options" role="group" aria-label={question.header}>
                {question.options.map((option) => {
                  const selected = answers[question.id]?.includes(option.label) ?? false;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      aria-pressed={selected}
                      disabled={sending}
                      onClick={() => {
                        if (!question.multiSelect) setCustomAnswers((current) => ({ ...current, [question.id]: '' }));
                        setAnswers((current) => ({ ...current, [question.id]: question.multiSelect
                          ? (current[question.id]?.includes(option.label)
                            ? current[question.id].filter((value) => value !== option.label)
                            : [...(current[question.id] ?? []), option.label])
                          : [option.label] }));
                      }}
                    >
                      <span className={`codex-question-mark${question.multiSelect ? ' multi' : ''}`} aria-hidden="true">
                        {selected && <Check size={10} strokeWidth={3} />}
                      </span>
                      <span className="codex-question-option-text">
                        <span>{option.label}</span>
                        {option.description && <small>{option.description}</small>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {question.allowCustom !== false && <AnswerField
              id={`codex-question-${request.requestId}-${question.id}`}
              secret={question.isSecret}
              placeholder={question.options?.length && !question.isSecret ? 'Or type your own answer…' : 'Your answer…'}
              value={customAnswers[question.id] ?? ''}
              disabled={sending}
              onChange={(value) => {
                if (!question.multiSelect) setAnswers((current) => ({ ...current, [question.id]: [] }));
                setCustomAnswers((current) => ({ ...current, [question.id]: value }));
              }}
              onSubmit={() => void submit()}
            />}
          </div>
        ))}
      </div>
      <div className="codex-question-footer">
        {error && <p role="alert">{error}</p>}
        <button type="button" className="codex-question-submit" disabled={sending || !complete} onClick={() => void submit()}>
          {sending ? 'Sending…' : request.questions.length > 1 ? 'Send answers' : 'Send answer'}
        </button>
      </div>
    </div>
  );
};

// A remote machine's questions are also re-read now and then, in case one of
// its push events was missed.
const REMOTE_QUESTION_POLL_MS = 20_000;

/**
 * A running subagent of the open thread whose questions show on it too (like
 * its "Needs you" action cards), so a question asked deep in a family is
 * answered where the user is looking. `remote`: it runs on another machine.
 */
export type SubagentQuestionSource = { threadId: string; title: string; remote?: RemoteQuestionSource };

type Source = { threadId: string; title?: string; remote?: RemoteQuestionSource };
type Pending = { request: CodexQuestionRequest; remote?: RemoteQuestionSource; from?: string };

const sourceKey = (source: Source) =>
  source.remote ? `${source.remote.machineId}:${source.remote.threadId}` : `local:${source.threadId}`;

export const CodexQuestions = ({
  threadId,
  onAsyncAnswer,
  remote,
  subagents,
  remoteTitle,
  explainApproval,
}: {
  threadId: string;
  onAsyncAnswer?: AsyncAnswerHandler;
  remote?: RemoteQuestionSource;
  /** Running subagents (any depth) whose questions show here too. */
  subagents?: SubagentQuestionSource[];
  /**
   * The title of a thread on another machine, by its id there: names the
   * subagent there that asked (that machine lists its subagents' questions
   * with the thread's own).
   */
  remoteTitle?: (machineId: string, hostThreadId: string) => string | undefined;
  /** Writes the approval card's plain-English "What it will do"; absent without a text-generation model. */
  explainApproval?: ExplainApproval;
}) => {
  const [pending, setPending] = useState<Pending[]>([]);
  const [revision, setRevision] = useState(0);
  const sources: Source[] = [{ threadId, remote }, ...(subagents ?? [])];
  const sourcesKey = sources.map((source) => `${sourceKey(source)}\u0000${source.title ?? ''}`).join('\u0001');
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const remoteTitleRef = useRef(remoteTitle);
  remoteTitleRef.current = remoteTitle;
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const current = sourcesRef.current;
    const read = async (source: Source, own: boolean): Promise<Pending[]> => {
      if (source.remote) {
        const result = await window.orion?.remoteListQuestions?.({
          machineId: source.remote.machineId,
          threadId: source.remote.threadId,
        });
        if (!result?.ok) throw new Error('unreachable');
        // That machine sends the thread's questions and its subagents' there.
        return (result.questions ?? []).map((request) => ({
          request,
          remote: source.remote,
          from:
            request.threadId !== source.remote!.threadId
              ? (remoteTitleRef.current?.(source.remote!.machineId, request.threadId) ?? 'a subagent')
              : own
                ? undefined
                : source.title,
        }));
      }
      const [codex, claude] = await Promise.all([
        window.orion?.getCodexQuestions?.(source.threadId),
        window.orion?.getClaudeQuestions?.(source.threadId),
      ]);
      return [...(codex ?? []), ...(claude ?? [])]
        .filter((request) => request.threadId === source.threadId)
        .map((request) => ({ request, from: own ? undefined : source.title }));
    };
    // What each source last listed: one that can't be read right now keeps
    // its questions (a transient IPC or network failure).
    const known = new Map<string, Pending[]>();
    const refresh = async () => {
      const mine = ++generation;
      const results = await Promise.all(
        current.map((source, index) =>
          read(source, index === 0).then(
            (list) => ({ key: sourceKey(source), list }),
            () => ({ key: sourceKey(source), list: null })
          )
        )
      );
      if (disposed || mine !== generation) return;
      for (const { key, list } of results) if (list) known.set(key, list);
      const seen = new Set<string>();
      const next: Pending[] = [];
      for (const source of current) {
        for (const item of known.get(sourceKey(source)) ?? []) {
          const id = `${item.remote?.machineId ?? 'local'}:${item.request.runId}:${item.request.requestId}`;
          if (seen.has(id)) continue;
          seen.add(id);
          next.push(item);
        }
      }
      setPending(next);
    };
    const localIds = new Set(current.filter((source) => !source.remote).map((source) => source.threadId));
    const machineIds = new Set(current.flatMap((source) => (source.remote ? [source.remote.machineId] : [])));
    const unsubscribers: Array<(() => void) | undefined> = [];
    let poll: number | undefined;
    if (machineIds.size > 0) {
      // A subagent there names its own thread: any of that machine's
      // question events may be one of these.
      unsubscribers.push(
        window.orion?.onRemoteEvent?.((event) => {
          if (!machineIds.has(event.machineId) || event.kind !== 'turnEvent') return;
          if (['user-input', 'done', 'error'].includes(event.payload?.type ?? '')) void refresh();
        })
      );
      poll = window.setInterval(() => void refresh(), REMOTE_QUESTION_POLL_MS);
    }
    if (localIds.size > 0) {
      unsubscribers.push(
        window.orion?.onAgentTurnEvent?.((event) => {
          if (localIds.has(event.threadId) && ['user-input', 'done', 'error'].includes(event.type)) void refresh();
        })
      );
    }
    void refresh();
    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe?.();
      if (poll !== undefined) window.clearInterval(poll);
    };
  }, [sourcesKey, revision]);
  if (!pending.length) return null;
  return (
    <div className="codex-questions" aria-label="Agent questions and approvals">
      {pending.map(({ request, remote: requestRemote, from }) => (
        <div key={`${requestRemote?.machineId ?? 'local'}:${request.runId}:${request.requestId}`}>
          {from && <div className="codex-question-from">From subagent {from}</div>}
          <QuestionCard
            request={request}
            refresh={() => setRevision((value) => value + 1)}
            onAsyncAnswer={onAsyncAnswer}
            remote={requestRemote}
            explain={explainApproval}
          />
        </div>
      ))}
    </div>
  );
};
