import type { Action, Snapshot } from './model.ts';

/** Task progress guides navigation without declaring an active agent invocation. */
export const planExecutionStarted = (s: Snapshot) => !!s.target && (
  s.target.tasks.some(t => t.done) || ['implement', 'verify', 'fix', 'done'].includes(s.phase)
);
export const contextSetupInDetails = (s: Snapshot, actionId: string) =>
  actionId === 'setup-context' && planExecutionStarted(s);

/** Routing is presentation. The selected skill remains the owner of execution/readiness. */
export function workflowActions(s: Snapshot): Action[] {
  const result: Action[] = [];
  const prefix = s.runtime === 'codex' || s.runtime === 'codex-app' ? '$' : '/';
  const hub = s.profile.startsWith('aifhub-');
  const installedHub = s.extensions.some(e => e.name === 'aifhub-extension' && e.state === 'present');
  const contextSkill = installedHub ? 'aif-analyze' : 'aif';
  const maintenance: Action[] = [
    { id: 'update-factory', label: 'Обновить AI Factory', command: 'ai-factory update', group: 'maintenance',
      reason: 'Обновить CLI через владельца установки, затем skills и зарегистрированные расширения проекта; без --force', available: !!s.versions.globalCli || s.configured },
    { id: 'setup-context', label: `Запустить ${contextSkill}`, command: `${prefix}${contextSkill}`, group: 'maintenance',
      reason: s.skills.includes(contextSkill) ? installedHub ? 'Настроить контекст проекта через AIFHub analyze' : 'Настроить контекст проекта через AI Factory' : `Сначала установите ${contextSkill} для ${s.runtime}`,
      available: s.skills.includes(contextSkill) },
  ];
  if (s.extensions.length) maintenance.push({ id: 'update-extensions', label: 'Обновить расширения', command: 'ai-factory extension update', group: 'maintenance',
    reason: 'Сначала обновить AI Factory и установку проекта, затем зарегистрированные расширения и проверить версии/команды; без --force', available: s.configured });
  // Maintenance can repair an outdated installation even when a selected plan
  // or workflow configuration cannot be resolved. Other actions stay blocked.
  if (s.profile === 'invalid') return maintenance.filter(action => action.id === 'update-factory' || action.id === 'update-extensions');
  if (!s.configured) return maintenance;
  const arg = s.target ? ` ${JSON.stringify(s.target.kind === 'openspec' || s.target.kind === 'classic' ? s.target.id : '@' + s.target.path)}` : '';
  const add = (id: string, label: string, skill: string, group: Action['group'], reason: string, target = arg) => {
    const available = s.skills.includes(skill);
    result.push({ id, label, command: `${prefix}${skill}${target}`, group, reason: available ? reason : `${reason} · skill не установлен для ${s.runtime}`, available });
  };
  const allDone = !!s.target?.tasks.length && s.target.tasks.every(t => t.done);
  const verify = s.checks.find(c => c.id === 'verify');
  const failed = s.checks.some(c => c.state === 'fail');
  const hasFindings = s.checks.some(c => c.state === 'fail');
  if (!s.target) {
    if (s.candidates.length > 1) return maintenance;
    add('plan', 'Составить план', 'aif-plan', 'next', 'Подготовить план новой задачи', hub ? ' full' : '');
    if (!hub && s.phase === 'explore') add('fix-new', 'Исправить проблему', 'aif-fix', 'next', 'Для исследованного дефекта; команда уточнит fix-now / plan-first', '');
    add('explore', 'Продолжить исследование', 'aif-explore', 'next', 'Уточнить требования до реализации', '');
    return [...result, ...maintenance];
  }
  if (s.target.kind === 'fix') {
    add('execute-fix', 'Выполнить исправление', 'aif-fix', 'next', 'Fix-план выполняет владелец aif-fix');
  } else if (s.profile === 'aifhub-ultra' && allDone && (s.phase === 'verify' || s.phase === 'done')) {
    add('ultra-receipt', 'Проверить receipt и следующий шаг', 'aif-done', 'next', 'Read-only проверка receipt: точный handoff verify или archive');
  } else if (s.phase === 'fix') {
    add('verify', 'Проверить исправление', 'aif-verify', 'next', 'После fix авторитетная повторная проверка остаётся за verify');
  } else if (hasFindings && (s.phase === 'verify' || allDone)) {
    add('fix-findings', 'Исправить замечания', 'aif-fix', 'next', 'Исправить выбранные findings; затем повторить verify');
    add('verify', 'Повторить проверку', 'aif-verify', 'next', 'Проверить актуальную реализацию');
  } else if (allDone) {
    if (hub && s.profile !== 'aifhub-ultra' && !failed && verify && ['reported-pass', 'warn'].includes(verify.state)) {
      add('done', 'Проверить готовность и завершить', 'aif-done', 'next', 'Verify и done readiness различаются; финализатор проверит актуальность evidence');
    } else add('verify', 'Проверить реализацию', 'aif-verify', 'next', 'Проверить завершённые задачи и обязательные gates');
    if (!hub) add('commit', 'Подготовить коммит', 'aif-commit', 'next', 'Verify необязателен в upstream; project-required checks сохраняются', '');
  } else if (s.phase === 'plan' || s.phase === 'explore' || (s.phase === 'unknown' && !planExecutionStarted(s))) {
    add('improve', 'Улучшить план', 'aif-improve', 'next', hub ? 'Основной handoff AIFHub после planning' : 'Необязательное уточнение плана');
    if (!hub || s.profile === 'aifhub-ultra') add('implement', 'Выполнить план', 'aif-implement', 'next', 'Начать выполнение выбранного плана');
  } else {
    add('implement', 'Продолжить выполнение', 'aif-implement', 'next', 'Возобновить с незавершённой задачи');
    add('improve', 'Уточнить план', 'aif-improve', 'next', 'Изменения требований возвращаются владельцу планирования');
  }
  if (s.phase === 'done' && s.profile !== 'aifhub-ultra') {
    // A declared phase is not proof of archive success. These are explicit owner actions.
    if (hub) add('sync', 'Синхронизировать артефакты', 'aif-mode', 'next', 'Синхронизация после подтверждённой финализации', ' sync');
    add('commit', 'Подготовить коммит', 'aif-commit', 'next', 'Коммит выполняется отдельно от done', '');
  }
  add('check-verify', 'Соответствие плану', 'aif-verify', 'check', 'Авторитетная проверка реализации');
  add('check-rules', 'Правила проекта', 'aif-rules-check', 'check', 'Rules gate; при необходимости сохранить durable evidence', s.profile === 'aifhub-openspec' ? arg : '');
  add('check-security', 'Безопасность', 'aif-security-checklist', 'check', 'Проверка безопасности в заявленном scope', '');
  add('check-review', 'Code review', 'aif-review', 'check', 'Review текущих изменений', '');
  if (s.profile === 'aifhub-openspec' && s.target.kind === 'openspec') {
    add('check-mode', 'Проверить конфигурацию', 'aif-mode', 'check', 'Read-only doctor выбранного change; без исправлений и синхронизации', ` doctor --change ${JSON.stringify(s.target.id)}`);
  }
  add('qa-prepare', 'Подготовить QA-сценарии', 'aif-qa', 'check', 'Подготовка сценариев не означает прохождение QA', '');
  add('qa-run', 'Пройти QA-сценарии', 'aif-qa-check', 'check', 'Выбрать human/agent режим; записать результаты сценариев', '');
  add('quality', 'Качество кода', 'aif-quality-setup', 'check', 'Read-only аудит стека и существующих проверок; команды не запускаются автоматически', ' audit');
  add('ci', 'Посмотреть CI', 'aif-chat', 'check', 'Проверить существующий CI для нужного SHA; не генерировать конфигурацию', ' ci');
  result[result.length - 1].available = true; // bundled plugin skill, not an AI Factory installation record
  add('quality-setup', 'Настроить проверки', 'aif-quality-setup', 'setup', 'Отдельная настройка подходящих quality tools', ' setup');
  add('ci-setup', 'Настроить CI', 'aif-ci', 'setup', 'Создание/аудит pipeline не означает успешный CI-run', '');
  return [...result, ...maintenance].filter((v, i, a) => a.findIndex(x => x.id === v.id) === i);
}

export function actionPrompt(s: Snapshot, action: Action): string {
  if (action.id === 'update-factory' || action.id === 'update-extensions') return [
    `Обнови ${action.id === 'update-extensions' ? 'зарегистрированные расширения с обязательным предварительным обновлением AI Factory' : 'AI Factory и затем зарегистрированные расширения'} по явному нажатию кнопки пользователем в этом чате. Контекст установки: ${JSON.stringify({ root: s.root, versions: s.versions, configured: s.configured, extensions: s.extensions })}.`,
    'Сначала проверь фактическое происхождение используемого CLI, конфигурацию проекта, зарегистрированные расширения и текущие локальные изменения. Выполняй этапы последовательно, не параллельно.',
    '1. AI Factory CLI. Обнови существующую установку через её владельца: для обычной глобальной npm-установки — npm install -g ai-factory@latest; для pnpm/yarn/mise или проектной dependency используй её существующий package manager и scope. Не создавай второй CLI, не понижай версию, не заменяй npm link/исходный checkout пакетом из registry и не делай git pull/reset в исходниках автоматически. Если установка связана с исходниками или provenance не подтверждён, сообщи точный owner-шаг вместо замены установки. Проверь фактическую версию используемого CLI. Подсказка self-update не считается обновлением пакета.',
    '2. Установка проекта. Если проект инициализирован, после обновления CLI заново выполни ai-factory update из рабочей папки проекта и проверь версию в .ai-factory.json. Эта команда сама проверяет расширения перед базовыми skills и затем переустанавливает extension skills/injections; не утверждай, что её внутренний порядок иной. Сохрани пользовательские изменения; не используй --force. Если обновление CLI или базовой установки не удалось/не подтверждено, остановись до следующего этапа и сообщи блокер. Если .ai-factory.json отсутствует, обнови только существующий CLI; не запускай init или обновление расширений.',
    '3. Расширения после AI Factory. Только после успешных этапов 1–2 заново прочитай список зарегистрированных расширений. Если список непустой, выполни ai-factory extension update — это корректная команда для всех зарегистрированных расширений; не используй ai-factory update extensions, extensions update или несуществующий --all. Обычный update мог уже обновить их: неизменная версия допустима, не применяй --force ради изменения номера. Не добавляй новые расширения, не удаляй конфигурацию и не запускай повторные циклы при ошибках.',
    '4. Проверка результата. Выполни ai-factory extension list для инициализированного проекта; сравни записанные версии расширений в .ai-factory.json с установленными extension.json. Проверь наличие объявленных extension-команд и SKILL.md (в том числе aif-analyze, если расширение его предоставляет) для текущего runtime, не запуская сами workflow-команды. Отдельно сообщи результаты CLI, проекта, каждого расширения и доступности команд: updated/unchanged/skipped/failed/unknown. Код 0 не заменяет проверку skipped/failed и отсутствующих файлов. Если список расширений пуст, отметь это и пропусти этап 3.',
    'После операции обнови карточку через aif_chat_status с принудительным чтением. Не запускай реализацию или проверки приложения.',
  ].join('\n');
  if (action.id === 'setup-context') return `${action.command}\n\nПользователь явно нажал запуск настройки контекста проекта. Примени именно ${action.command} в текущем проекте по установленному skill-контракту. Не выполняй план и не начинай реализацию. Когда настройка завершится, обнови карточку через aif_chat_status. Выбранный ранее план не является аргументом этой команды.`;
  return `${action.command}\n\nКонтекст кнопки AI Factory: ${JSON.stringify({ target: s.target?.path ?? null, profile: s.profile, expectedFingerprint: s.fingerprint })}.\nВыполни выбранное действие в текущей задаче. Сначала перечитай выбранный план/change и действующие правила. Для новой задачи без описания запроси её описание. Не расширяй scope. Не считай старые отчёты актуальным PASS без проверки evidence. После этапа обнови карточку через aif_chat_status или bb plugin run aif-chat show. Нажатие этой кнопки не разрешает другие действия workflow.`;
}
