import type { EnsobotInteraction, EnsobotResponse } from '@shared/ensobot/interaction';
import type { EnsobotSnapshot } from '@shared/ensobot/snapshot';
import { useState } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { useI18n } from '@/i18n';
import { runCommand } from './useEnsobot';

/** 顶部汇总栏：不在当前聊天面干活的成员的审批/提问。就地显示的那些由 exclude 排除。 */
export function EnsobotInteractions({
  snapshot,
  exclude,
}: {
  snapshot: EnsobotSnapshot;
  exclude?: ReadonlySet<string>;
}) {
  const items = (snapshot.interactions ?? []).filter((item) => !exclude?.has(item.id));
  if (!items.length) return null;
  return (
    <section
      aria-label="EnsoBot approvals and questions"
      className="max-h-[40vh] shrink-0 overflow-y-auto border-b bg-background px-4 py-2"
    >
      {items.map((item) => (
        <EnsobotInteractionItem
          key={item.id}
          item={item}
          name={snapshot.cards.find((card) => card.id === item.cardId)?.name ?? item.cardId}
        />
      ))}
    </section>
  );
}

export function EnsobotInteractionItem({
  item,
  name,
  inline = false,
}: {
  item: EnsobotInteraction;
  name: string;
  /** 就地显示在成员进度下面：谁、要什么已经写在进度行和审批条里，不再重复标题。 */
  inline?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const respond = async (response: EnsobotResponse) => {
    if (busy || item.responding) return;
    setBusy(true);
    setError('');
    const deliveryId = crypto.randomUUID();
    const result = await runCommand(
      { type: 'ensobot-respond', response, deliveryId },
      () => window.electronAPI.ensobot.respond(response),
      deliveryId
    );
    if (!result.ok) {
      setError(result.error ?? t('Failed'));
      // 复用条内的乐观 disable 在传输失败时必须解开，不能只能重载窗口重试。
      setAttempt((value) => value + 1);
    }
    setBusy(false);
  };
  const base = { id: item.id, cardId: item.cardId };
  return (
    <div data-slot="ensobot-interaction" className="mb-2">
      {inline ? null : (
        <p className="mb-1 text-xs font-medium">
          {name} · {t(item.kind === 'approval' ? 'Approval required' : 'Waiting for your answer')}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <fieldset disabled={busy || item.responding} className="min-w-0 disabled:opacity-60">
        {item.kind === 'approval' ? (
          <ApprovalBar
            key={attempt}
            approvals={[item.request]}
            onRespond={(_requestId, decision) =>
              void respond({ ...base, kind: 'approval', decision })
            }
          />
        ) : (
          <AskBar
            key={attempt}
            asks={[item.request]}
            onAnswer={(_requestId, answer) => void respond({ ...base, kind: 'ask', answer })}
          />
        )}
      </fieldset>
    </div>
  );
}
