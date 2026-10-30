import { useEffect, useState } from 'react';
import { Check, MessageCircleQuestion } from 'lucide-react';

export type CodexQuestionRequest = {
  providerId?: 'codex' | 'claude';
  /** Astra's request_user_input_async: answered with an ordinary steered user message. */
  async?: boolean;
  detail?: string;
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

export const asyncAnswerText = (request: CodexQuestionRequest, answers: Record<string, string[]>) =>
  request.questions.map((question) => `${question.question}\n${answers[question.id].join(', ')}`).join('\n\n');

const QuestionCard = ({
  request,
  refresh,
  onAsyncAnswer,
}: {
  request: CodexQuestionRequest;
  refresh: () => void;
  onAsyncAnswer?: AsyncAnswerHandler;
}) => {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const answerFor = (id: string) => [...(answers[id] ?? []), ...(customAnswers[id]?.trim() ? [customAnswers[id]] : [])];
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const complete = request.questions.every((question) => answerFor(question.id).length > 0);

  const submit = async () => {
    if (sending || !complete) return;
    setSending(true);
    setError('');
    try {
      if (request.async && !onAsyncAnswer) throw new Error('No async answer handler');
      const send = request.providerId === 'claude' ? window.orion?.answerClaudeQuestions : window.orion?.answerCodexQuestions;
      const answers = Object.fromEntries(request.questions.map((question) => [question.id, answerFor(question.id)]));
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
    }
  };

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
            {question.allowCustom !== false && <input
              id={`codex-question-${request.requestId}-${question.id}`}
              type={question.isSecret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={question.options?.length && !question.isSecret ? 'Or type your own answer…' : 'Your answer…'}
              value={customAnswers[question.id] ?? ''}
              disabled={sending}
              onChange={(event) => {
                if (!question.multiSelect) setAnswers((current) => ({ ...current, [question.id]: [] }));
                setCustomAnswers((current) => ({ ...current, [question.id]: event.target.value }));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
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

export const CodexQuestions = ({ threadId, onAsyncAnswer }: { threadId: string; onAsyncAnswer?: AsyncAnswerHandler }) => {
  const [requests, setRequests] = useState<CodexQuestionRequest[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const [codex, claude] = await Promise.all([
          window.orion?.getCodexQuestions?.(threadId),
          window.orion?.getClaudeQuestions?.(threadId),
        ]);
        const pending = [...(codex ?? []), ...(claude ?? [])];
        if (!disposed && current === generation) setRequests(pending ?? []);
      } catch {
        // Keep existing answers available during a transient IPC failure.
      }
    };
    const unsubscribe = window.orion?.onAgentTurnEvent?.((event) => {
      if (event.threadId === threadId && ['user-input', 'done', 'error'].includes(event.type)) void refresh();
    });
    void refresh();
    return () => { disposed = true; unsubscribe?.(); };
  }, [threadId, revision]);
  const visible = requests.filter((request) => request.threadId === threadId);
  if (!visible.length) return null;
  return (
    <div className="codex-questions" aria-label="Agent questions and approvals">
      {visible.map((request) => (
        <QuestionCard
          key={`${request.runId}:${request.requestId}`}
          request={request}
          refresh={() => setRevision((value) => value + 1)}
          onAsyncAnswer={onAsyncAnswer}
        />
      ))}
    </div>
  );
};
