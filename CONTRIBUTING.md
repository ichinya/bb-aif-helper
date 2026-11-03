# Разработка

[README](README.md) · [Проверенные результаты](VERIFICATION.md)

## Локальная сборка

Нужны Git, Node.js/npm и BB. Проверенная среда: Windows, Node.js 24.13.0, npm 11.18.0, BB 0.48.1, Plugin SDK 0.6.104. Для тестов нужен `node:module.registerHooks`; используйте Node 24. `better-sqlite3` может потребовать подходящий prebuilt binary или инструменты нативной сборки.

```text
git clone https://github.com/ichinya/bb-aif-helper.git
cd bb-aif-helper
npm ci --include=dev
npm run typecheck
npm test
bb plugin build .
bb plugin install .
```

Установку из папки выполняйте один раз. После правок уже установленного плагина:

```text
bb plugin build .
bb plugin reload aif-chat
```

React и frontend SDK предоставляет BB. Не коммитьте `node_modules`, кэши, `dist` и `.tgz`; Git-установка собирается средствами BB.

## Исходники

- `app.tsx`, `aif-chat.css` — карточка, кнопка заголовка, правая панель и контекстная секция.
- `server.ts` — RPC, agent tool, CLI, настройки, selection и защита доставки.
- `host.ts` — host entry на хосте рабочей среды чата.
- `reader.ts` — read-only чтение версий, metadata, skills, задач и отчётов.
- `workflow.ts` — маршруты и запросы владельцам skills.
- `suggestions.ts` — ограниченный разбор имён `$aif…` в последнем ответе агента; server RPC отвечает за проверку и доставку, composer banner — за показ и крестики.
- `gate.ts` — разбор завершающего `aif-gate-result`, проверка семантики и допустимых рекомендаций; данные JSON не становятся произвольными командами.
- `check-history.ts` — привязка завершённых gates из истории к явному canonical plan path и отдельное отображение результатов чата без подмены файлового evidence.
- `check-actions.ts` — соответствие строк действиям и единая блокировка повторных gates при неизменном отпечатке входов; сервер и UI сохраняют причину отключения отдельно от отсутствующего skill.
- `snapshot-cache.ts` — общий stale-while-revalidate кэш с объединением запросов, поколениями invalidation, задержкой после ошибок и сохранением через SQLite в `server.ts`. Снимок файлов не включает состояние чата и историю gates: они добавляются для каждого ответа отдельно.
- `versions.ts` — суточный срок хранения версий и правила размещения updater-кнопок. `server.ts` хранит CLI/Git-снимки в отдельной таблице, резервирует внешние попытки в сохранённом upstream-кэше и сбрасывает локальную версию при maintenance.
- `model.ts`, `contract.ts` — schemas и RPC-контракты.
- `skills/aif-chat/SKILL.md` — инструкции агенту, CLI и просмотр CI.
- `tests/` — fixtures, parser/routing tests, официальный SDK harness и проверка публичных импортов.

## Проверки

Перед отправкой изменений запустите typecheck, tests и build. UI-правки дополнительно проверьте в реальном BB: harness не доказывает размещение, CSS и поведение хоста.

Тесты используют временные fixtures и заглушки SDK. Они не запускают модель, платный inference, пользовательские навыки или CI приложения. URL с `user:secret@example.org` в fixture намеренно синтетический: проверяет удаление credentials и query из отображаемого источника расширения.

При live-проверке нажатие workflow-кнопки отправляет команду агенту. Открытие панели можно проверять без запуска workflow.

## Сохраняемые контракты

- Только публичный `@get-bb/plugin-sdk`, без private `@bb/*`.
- Read-only status не импортирует extension JS и не запускает workflow.
- Старый отчёт не превращается в подтверждённый актуальный PASS.
- Owner handoff, gate blocks и upstream/AIFHub/legacy ultra остаются разделены.
- Перед отправкой проверяются цель, fingerprint, skill, занятость, очередь и вопросы.
- Неопределённая доставка не повторяется автоматически; полномочия BB не обходятся.
- При добавлении поверхности обновляются README, `PLUGIN_OVERVIEW.md` и агентский skill.

## Сообщения об ошибках

В [issue](https://github.com/ichinya/bb-aif-helper/issues) укажите версии BB/плагина, ОС, профиль workflow, ожидаемое и фактическое поведение. Для воспроизведения предпочтителен синтетический минимальный проект.

Перед отправкой логов/status JSON/скриншотов удалите токены, имена закрытых репозиториев, абсолютные локальные пути и частные планы. Не публикуйте реальные секреты для демонстрации ошибки.
