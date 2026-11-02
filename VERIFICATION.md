# Проверка AI Factory Chat 0.1.2

Проверено 2 ноября 2026 года на Windows, BB Plugin SDK 0.6.104.

## Автоматические проверки

- TypeScript: `node node_modules/typescript/bin/tsc --noEmit`.
- Fixture и SDK tests: `npm test` — 51 passed, 0 failed, 0 skipped.
- Public SDK import scan входит в tests; private BB dependencies не используются.
- `bb plugin build .` создаёт server, app и self-contained host bundles.

Покрыты upstream/AIFHub маршруты, отдельный legacy ultra, canonical tasks и nested tasks, malformed YAML, отсутствие fallback версии, испорченная установка расширения, отсутствие выполнения extension JS, неподтверждённый PASS, stale/duplicate/uncertain dispatch, занятый thread, pending questions, disabled plugin и frontend через официальный BB harness.

При повторной проверке исправлены:

1. Неблокирующий verify WARN больше не отправляет AIFHub в лишний fix-loop.
2. Кнопка OpenSpec rules сохраняет явный выбранный change.
3. Scalar YAML и некорректный tools mapping отключают workflow вместо скрытого fallback.
4. Отключённый plugin перестаёт добавлять агенту свой tool/skill/instructions при следующем разрешении конфигурации сессии.
5. Документация заменена на фактическое назначение плагина; fallback использует устойчивый явный BB CLI entrypoint.

В 0.1.1 добавлены независимые от плана кнопки обновления AI Factory и запуска `aif`/`aif-analyze`. Тестами проверены отсутствие автоматического update, выбор analyze по установленному расширению, обнаружение custom skills, отсутствие аргумента плана у setup, запрет запуска отсутствующего skill, защита busy/pending и передача updater-запроса только в текущий чат. Версии установки включены в fingerprint карточки.

## Live-проверки

В 0.1.2 добавлены постоянная кнопка в заголовке и fixed-вкладка AI Factory справа. SDK harness проверяет маршрут открытия панели без отправки команд и чтение данных принадлежащего панели thread. Контроль запуска workflow и обновления остаётся общим с карточкой.

- `aif-chat@0.1.2` собран и перезагружен со статусом running. В настоящем окне BB нажата кнопка AI Factory в заголовке: справа открылась панель с CLI 2.19.0, Git 2.21.0 и кнопками обновления/запуска. Workflow не запускался. В Personal workspace запуск aif корректно отмечен как не установленный.

- Path-installed `aif-chat@0.1.0` успешно загружен и перезагружен в BB.
- Frontend bundle совместим с SDK 0.6.104.
- `status` RPC читает данные через настоящий host worker.
- В Personal workspace правильно показано отсутствие проектной установки, глобальный CLI 2.19.0 и исходники Git 2.21.0.
- В существующем проектном чате прочитана установка 2.12.0, найдено 17 кандидатов планов и 25 доступных skills; выбран план текущей ветки, сформированы 12 действий. Никакая команда этого проекта не отправлялась.
- Через native Computer Use в окне BB подтверждено отображение карточки в сообщении и раздельных версий. Workflow action buttons проверены в UI harness; реальные модельные вызовы нажатием не запускались.
- Удалённый статус GitHub доступен отдельным запросом/кэшем с ref, SHA и timestamp; отсутствие network-check не заменяется предполагаемой версией.

## CLI-ограничение текущего BB на Windows

Короткий alias `bb aif-chat status ...` возвращает корректный JSON, затем процесс завершается с `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`. Контроллерский exit code — 1; это не записано как успешный CLI-run.

Устойчивые варианты, проверенные с exit code 0:

```text
bb plugin run aif-chat status --thread <id> --json
bb plugin rpc call aif-chat status --input-file <input.json> --json
```

Прямой HTTP RPC также возвращает `ok: true`. Native tool и кнопки используют SDK/RPC и не вызывают короткий alias. Его код BB в рамках этой работы не менялся; явный entrypoint указан в skill и подсказках агента.

## Граница результата

Это проверка plugin contracts, локального UI и live read-only status. Реальные inference, QA приложения, hosted CI, archive, commit, push или PR не запускались. Существующий AIFHub Flow не изменялся. Плагин не присваивает актуальный PASS по одному старому отчёту и не заменяет readiness/evidence-владельцев.
