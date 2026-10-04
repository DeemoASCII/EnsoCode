import { canBeVirtualMember, classifierProviderFor } from '@shared/virtualModels';
import * as React from 'react';
import { useI18n } from '@/i18n';
import {
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { ClassifierSourceField } from './VirtualModelsSettings';

/** Bot 模式的全局设置；只在「实验」里开启 Bot 模式后出现在导航里 */
export function BotSettings() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('Bot mode')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Settings shared by all members and group chats.')}
        </p>
      </div>
      <BotRouteClassifierRow />
    </div>
  );
}

function BotRouteClassifierRow() {
  const { t } = useI18n();
  const value = useSettingsStore((s) => s.botRouteClassifier);
  const setValue = useSettingsStore((s) => s.setBotRouteClassifier);
  const providers = useSettingsStore((s) => s.providers);
  const snapshot = useOauthCredentialStore((s) => s.snapshot);
  const usable = React.useMemo(
    () => usableProvidersForOauthSnapshot(providers, snapshot),
    [providers, snapshot]
  );
  const candidates = React.useMemo(() => usable.filter(canBeVirtualMember), [usable]);
  const classifierProviders = React.useMemo(
    () => usable.filter((provider) => classifierProviderFor(provider) !== undefined),
    [usable]
  );
  return (
    <div className="rounded-md border px-3 py-2.5" data-settings-row="bots.routeClassifier">
      <p className="text-sm">{t('Group reply picker model')}</p>
      <p className="mb-2 text-xs text-muted-foreground">
        {t(
          'When nobody is @-mentioned in a smart-routing group, this model picks which member replies.'
        )}
      </p>
      <ClassifierSourceField
        value={value ?? undefined}
        onChange={(next) => setValue(next ?? null)}
        providers={candidates}
        classifierProviders={classifierProviders}
        offLabel={t('Default (title model)')}
        judgeLabel={t('Fast chat model')}
        description={t('Falls back to the group owner on timeout, error or an unclear answer.')}
      />
    </div>
  );
}
