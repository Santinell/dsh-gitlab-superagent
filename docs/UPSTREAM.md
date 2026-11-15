# Отличия GitLab-форка от апстрима и факты P0

**Дата:** 2026-11-15 · **Стенд:** self-managed `gitlab.campbox.tech`, GitLab **19.2.9** (`enterprise: false`, Free/CE), проект `tlcamp/human-resources` (id 25), `glab` 1.121.0.

Документ фиксирует проверенные факты и явно помеченные ограничения. Фикстуры по путям `tests/fixtures/…` доступны в исходном checkout; тестовые данные не включаются в npm tarball.

## 1. Аутентификация и git

| Проверка | Результат |
| --- | --- |
| `glab auth status --hostname gitlab.campbox.tech` | залогинен как `pavel.evdokimov`, токен в keyring |
| `glab api user` | системный `glab` работает только с `--hostname gitlab.campbox.tech`; без него уходит на `gitlab.com`, потому что checkout — GitHub-репозиторий. Обёртка `glab-agent` экспортирует `GITLAB_HOST` и `GITLAB_TOKEN` из файла, тогда флаг не нужен |
| `git credential fill` для `https://gitlab.campbox.tech` | вернул `username` и пароль из credential helper |
| `git clone` пустого проекта | успешно |
| push в `p0/credential-check` | успешно, без интерактива; `GIT_TERMINAL_PROMPT=0` |
| push в `main` | отклонён: `main` была защищена на время проверки (push — `No one`); после проверки защита снята (см. §4) |
| `glab --setup-git-credential-helper` | не запускался: на стенде уже настроен `credential.https://gitlab.campbox.tech.helper = !/usr/bin/glab auth git-credential` |
| отдельный `glab-agent` | проверен env-token wrapper: отдельный аккаунт, credential helper, push, без рекурсии |

**Вывод для P1:** хост фиксируется в `glab-agent` через `GITLAB_HOST` (плюс `GITLAB_API_HOST`, если API на другом host:port). Тогда setup/`Commands`/worker не передают `--hostname`; для системного `glab` вне обёртки он остаётся обязательным. Setup должен сверять host из `user.web_url`/`project.web_url` с `codeHost.host`. `git`-часть работает через `glab auth git-credential`.

## 2. Версия и проект

| Поле | Значение |
| --- | --- |
| GitLab | `19.2.9`, revision `6e4a6dd741a`, `enterprise: false` |
| проект | `tlcamp/human-resources`, id `25`, private |
| default branch при создании | `main` |
| проект на момент спайка | был пустым; после теста появились ветки `p0/credential-check`, `p0/mr-source`, issue #1/#2, MR !1 и pipeline 1179. После P0 тестовые issue/MR/pipelines и ветки удалены; осталась `main` с пустым коммитом |
| `permissions` текущего пользователя | `project_access: null`, `group_access: { access_level: 40 }` — Maintainer по группе |
| `commit_email` в `GET /user` | есть; fallback `<id>-<username>@users.noreply.<host>` не нужен на этом стенде |

**Вывод:** проверка доступа должна учитывать и `project_access`, и `group_access`; `access_level >= 30` — запись, `>= 40` — Maintainer. `resolveAccess()` покрыт `tests/gitlab-access.spec.ts`.

## 3. `glab api`

### 3.1. Пагинация

`glab api --paginate` **не** возвращает один JSON-массив. На двух страницах он печатает подряд два массива:

```text
[...page 1...][...page 2...]
```

`jq` разбирает только первый массив. Для потоковой обработки нужен `--output ndjson`:

```sh
glab api --hostname <host> "projects/25/issues?per_page=1" --paginate --output ndjson
```

Фикстуры: `tests/fixtures/gitlab/api/issues-page.json`, `tests/fixtures/gitlab/api/issues-paginate-2pages.json`, `tests/fixtures/gitlab/api/issues-paginate.ndjson`.

**Вывод для P1-05:** `Commands.pages()` должен использовать `--paginate --output ndjson` (или разбирать страницы отдельно), а не `JSON.parse` всего вывода.

### 3.2. Ошибки

404 возвращает:

```json
{"message":"404 Not found"}
```

а `glab` печатает `glab: 404 Not found (HTTP 404)` и завершается с ненулевым кодом. 403 и 429 не проверялись. `commandError()` должен сохранять HTTP-код из stderr.

### 3.3. Плейсхолдеры

`:fullpath`, `:id`, `:branch` работают из git-репозитория с remote на GitLab. Setup выполняется не в целевом клоне, поэтому путь проекта нужно передавать явно (`projects/<urlencoded path>` или через `-R`), а не рассчитывать на `:fullpath`.

## 4. Защита веток и approvals

- На стенде `main` была без защиты и защищена вручную: push — `No one`, merge — Maintainers. Push в `main` отклонён pre-receive hook. После проверки защита снята, чтобы вернуть проект как был.
- Ветка `p0/credential-check` после первого push стала default и была защищена автоматически; после проверки ветка удалена, default — `main` с пустым коммитом.
- `GET /projects/25/approvals` → `404 Not Found` на Free/CE.
- `GET /projects/25/merge_requests/1/approvals` работает, но на Free возвращает только `user_has_approved`, `user_can_approve`, `approved`, `approved_by`; полей `approvals_required`/`approvals_left` нет.
- `approvals_before_merge` в MR — `null`.

**Вывод:** план «protected `main` + approvals только как факты» верен, но на тестовом проекте защиту `main` нужно включить отдельно. Схема approval должна допускать отсутствие `approvals_required`/`approvals_left`; отдельное approval-правило не требуется.

## 5. TODOs

`GET /todos` — user-level; `project_id=25` фильтрует. Самоназначение issue на себя **не создаёт todo** (появляется только system note `assigned to @…`). TODO появился после комментария project access token с упоминанием `@pavel.evdokimov`:

```json
{"action_name":"directly_addressed","target_type":"Issue","target":{"iid":1},"state":"pending"}
```

**Вывод:** P2 не может рассчитывать только на «упоминание в issue создаёт todo»; нужны наблюдаемые потоки и дедуп, как в R2. `target.iid` у todo есть не всегда — нужен guard.

## 6. CI

- `.gitlab-ci.yml` на ветке `p0/credential-check` запустил pipeline **1179**, статус `success`; после снятия фикстур pipeline удалён.
- job **12991** `p0-job`, stage `test`, статус `success`.
- group runner `docker-executor` online, tagless (`run_untagged: true`), `tag_list: ["docker-executor"]`.
- `shared_runners_enabled: false`, но group runner доступен.

Фикстуры: `tests/fixtures/gitlab/entities/pipeline.json`, `tests/fixtures/gitlab/entities/jobs.json`.

**Вывод:** pipeline/job — рабочий источник CI-фактов; `CiSnapshot` можно строить из `pipelines/:id` + `jobs`.

## 7. Лимиты

- Заголовков `RateLimit-*` на обычных запросах к issues/todos **не было**.
- `X-Next-Page`, `X-Page`, `X-Per-Page`, `X-Total`, `X-Total-Pages` есть.
- `per_page=101` и `per_page=500` обрезаются до `X-Per-Page: 100`.
- `todos` документирован как 300 запросов/мин на пользователя, но заголовки лимита на стенде не отдавались.
- 429/`Retry-After` не проверялись, чтобы не выжигать лимит.

Фикстуры: `tests/fixtures/gitlab/rate-limit/`.

**Вывод:** правило «`per_page=100`, минимум 60 с, `updated_after`» остаётся; на `RateLimit-*` нельзя рассчитывать как на единственный сигнал. При 429 нужен backoff по `Retry-After`, если он придёт.

## 8. Безопасность фикстур

`GET /projects/25` для Maintainer содержит `runners_token`. Из `tests/fixtures/gitlab/entities/project.json` и остальных фикстур удалены `runners_token`, `_links`, `ci_config_path` и служебные поля. Email/имя пользователя заменены на `agent@example.com` / `Agent User`. TODO из других проектов в фикстуры не попали.

## 9. Что осталось проверить

- 403 проверен (`insufficient_scope`, `glab: HTTP 403`); 429/`Retry-After` — accepted risk, не проверялся.
- Env-token wrapper проверен: identity project-бота, credential helper, push, отсутствие рекурсии; оператор остаётся залогинен.
- Push в `main` проверен после защиты: отклонён.
- Read-only/no-access через CLI-пользователя: сейчас проверены токены Reporter/Developer через API; отдельный CLI-пользователь не создавался.
- Поведение `glab api --paginate` на GraphQL и на вложенных списках (notes/discussions).

## 10. Базовая линия проверок

- `pnpm typecheck` — зелёный.
- `pnpm build` — зелёный.
- `pnpm exec vitest run tests/gitlab-access.spec.ts tests/docs.spec.ts tests/class-docs.spec.ts` — 13 тестов зелёные.
- Полный `pnpm check` падает на существующем тесте Feishu `tests/sources.spec.ts:1097` (`state: ready` вместо `error`), не связанном с P0. Остальные 1211 тестов проходят.

## 11. Изоляция аккаунта агента: keyring и env-token wrapper

Первый вариант wrapper’а — отдельный `GLAB_CONFIG_DIR` плюс `glab auth login --insecure-storage` — оказался небезопасен: `GLAB_CONFIG_DIR` меняет только конфиг-файл, а OS keyring общий для пользователя и хоста. Логин агента сбросил keyring-токен оператора, и оператору пришлось заново выполнять `glab auth login`. **Вывод: `glab auth login` для агента на том же OS-пользователе не использовать.**

Рабочая схема — **env-token wrapper**:

- токен агента лежит в `$GLAB_CONFIG_DIR/token` с правами `0600`;
- wrapper экспортирует `GLAB_CONFIG_DIR`, `GITLAB_HOST` и `GITLAB_TOKEN` из этого файла;
- вызывается настоящий `glab` по абсолютному пути;
- `glab auth login` и keyring не используются.

Проверено на GitLab 19.2.9:

| Проверка | Результат |
| --- | --- |
| `glab-agent api user` | project-бот, отдельный от оператора |
| `glab-agent auth git-credential get` | username `glab`, токен подставлен; git push проходит |
| push в `p0/env-wrapper-check` | успешно, без интерактива |
| `PATH=worker-bin:$PATH glab-agent --version` | без рекурсии |
| `glab-agent auth status` | «not authenticated» — **не использовать как setup-пробу**; проверка — `glab-agent api user` |
| 403: read-only token создаёт issue | `glab: HTTP 403`, код сохраняется |

Оператор при env-token wrapper’е остаётся залогинен. Все временные project access tokens (47–53) отозваны; проект снова содержит только `main` с пустым коммитом.

**429/`Retry-After`** не проверялись, чтобы не выжигать лимит: принято как риск; backoff реализуется по `Retry-After`, если он придёт.

## 12. P2: источник GitLab и проверки

**Дата:** 2026-11-15. Реализованы `src/sources/gitlab-trigger.ts`, `gitlab-channel.ts`, `gitlab-read.ts`, `gitlab-mr.ts`, `gitlab.ts`, `retry.ts` и `KV.gitlab`.

| Проверка | Результат |
| --- | --- |
| `pnpm check` | зелёный: typecheck, 1243/1243 тестов, build |
| `lib/gitlab-watch.js` | собирается; `github-watch`/`feishu-watch` больше не входят в сборку |
| Feishu в runtime | модули `src/sources/feishu*.ts`, `lark()`, `lark-cli`-шим и Feishu-поля setup/HTTP/runtime удалены; строки Feishu остаются только в UI-локалях (`src/client/locales.ts`) до P4 и в тестовом fixture |
| пагинация | `Commands.gitlabPages` использует `--paginate --output ndjson` (по P0) |
| CI | факты строятся из `pipelines/:id` + `jobs`; упавшие джобы и статус пайплайна дают `CiSnapshot`, без check-runs |
| идемпотентность | маркер `<!-- dsh-superagent:<id> -->` в note; Trigger ID детерминирован по note id и `updated_at` |
| TODO | `GET /todos?project_id=…` только подсказка: наблюдаемые потоки `issues`/`merge_requests?updated_after=` покрывают пропущенные TODO |
| live-демо P2-09 | **не пройдено**: нет аккаунта агента (Maintainer, PAT `api`+`write_repository`) и второго аккаунта на self-managed GitLab 19.2.9 Free |

**Отклонение тестовой инфраструктуры:** старые Feishu-тесты ядра сохранены как `tests/fixtures/feishu/` с `lark`-транспортом в `tests/setup.ts`; production-код Feishu удалён, fixture и `KV.feishu` удаляются в P7. Это позволило не переписывать ~230 тестов ядра в P2.

**Что должен проверить оператор стенда (P2-09):** issue с `@agent` → Ticket и ответ в том же issue; ветка с последним сегментом имени Ticket → MR привязывается; комментарий человека в треде MR без повторного упоминания; повторный раунд без дублей; `scope`/`health` в панели; отключение источника останавливает поллинг; чужой MR не привязывается.

## 13. P5: CI, approvals и lifecycle (2026-11-15)

Локальная семантика CI:

- Fingerprint — отсортированное множество имён упавших обязательных jobs (`stage/name`, либо `name`, если stage отсутствует). ID jobs/pipeline, sha и ref не входят в fingerprint; одноимённые jobs разных stages различаются. `failed` и `canceled` считаются падением; `allow_failure=true` остаётся в исходных jobs, но не создаёт падение. Failed/canceled pipeline без соответствующей failed job даёт `pipeline:<status>`.
- Первый снимок создаёт baseline. Новый ID с теми же падениями ничего не порождает. Падения сохраняются при отсутствии pipeline, running/pending, manual/blocked, scheduled/skipped и неизвестном статусе. Только подтверждённый `success` без ожидающих обязательных jobs очищает набор. `manual` с `allow_failure=false` ожидает человека; optional manual не блокирует успешный pipeline.
- [Jobs API](https://docs.gitlab.com/api/jobs/#list-pipeline-jobs) по умолчанию исключает старые retried attempts; `include_retried=true` не используется. Нечитаемая job не может подтвердить восстановление: pipeline snapshot отклоняется, checkpoint остаётся. Pipeline предыдущего MR SHA не используется как успешный результат нового commit.
- MR и default branch используют одинаковую семантику. Смена default branch создаёт новый baseline; временное отсутствие pipeline сохраняет старый checkpoint. Revision/fingerprint сохраняются в KV и проверены через перезапуск Runtime.

[Approvals API](https://docs.gitlab.com/api/merge_request_approvals/#retrieve-approval-state-for-a-merge-request) читается через `gitlab/merge_requests/<iid>/approvals`. Схема основана на P0 `approval.json` с Free-сервера: `approved` и `approved_by`, без обязательных `approvals_required/approvals_left`. Ресурс возвращает `available`, nullable `approved` и usernames `approved_by`; MR description содержит указатель `approvals_resource`. Тред показывает Approved/Approvals, отзыв очищает список. 403/404 — unavailable, а не отсутствие approvals; transient/rate-limit ошибки оставляют capability unknown, не блокируя чтение MR lifecycle/CI/discussions, но учитываются в health/backoff раунда. Ни approvals, ни auto-merge не дают права merge и не добавляют барьер перед ready/Assignment.

В P0-фикстуре GitLab 19.2.9 присутствует `merge_when_pipeline_succeeds=false`, `detailed_merge_status=mergeable`; поля `auto_merge_enabled` нет. [REST MR API](https://docs.gitlab.com/api/merge_requests/#get-single-merge-request) документирует `merge_when_pipeline_succeeds`. Optional `auto_merge_enabled` поддерживается как совместимый вход, с приоритетом при явном boolean; nullable/отсутствующее поле использует старое поле, затем false. Это совместимость, а не подтверждение выдачи нового поля реальным сервером. Новая live-проверка целевой версии остаётся P7.

`state=locked` остаётся terminal согласно существующему контракту P2, а `discussion_locked=true` само по себе не закрывает MR/Ticket. Нельзя автоматически привязывать agent MR из fork, с неизвестным source/target project, чужим автором или другой веткой. Явно принятый source MR может быть чужого автора. Merge/close отмечает follow один раз; ядро завершает Ticket и Assignment, когда работа закончена. После reopen завершённый Ticket автоматически не воскресает; незавершённая работа после закрытия следует существующим правилам ядра до ready.

429 внутри streams/MR/jobs сохраняет HTTP-код и максимальный backoff раунда. Поддержаны Retry-After seconds/HTTP-date, fallback 300 секунд, минимум поллинга 60 секунд. Один сбой не останавливает независимые targets; неполный stream не продвигает общий курсор. Disable/abort во время чтения не разрешает следующий API-запрос и не продвигает непрочитанный notes checkpoint. TODO mark-as-done остаётся best effort; детерминированные IDs исключают повторную доставку при overlap/restart.

Проверки используют реальные Store/Engine/Runtime и P0 fixtures с подменой CLI. **Реальные 429, новые pipeline/approvals/merge на self-managed и GitLab.com в P5 не запускались.** Принятый риск P0 сохраняется; live smoke P7-05/P7-06 обязателен.

## 14. Исправления независимого ревью P1–P5 (2026-11-15)

- Issue reply с `#note_<id>` больше не ищет MR discussions с совпавшим IID. Только MR note требует поиска discussion; поиск входит в обработку gone/retryable ошибок. Удалённая discussion не подменяется top-level комментарием.
- Новый mention в описании старого Issue/MR обрабатывается как событие TODO, независимо от `entity.created_at` и notes cursor. Используются автор действия, время и body snapshot из TODO, а не автор Issue или позднее отредактированное описание. ID привязан к TODO; первое описание при создании может использовать обычный entity ID, повторные mentions получают отдельные IDs. В MR meta сохраняется настоящий автор MR отдельно от автора mention. Полные TODO, нужные при сбое, сохраняются с retry до успешного чтения notes; повторные раунды не создают события заново. TODO на note URL обрабатывается через notes/discussions, не как описание. API-контракт: [To-Do List API](https://docs.gitlab.com/api/todos/).
- Read-only startup guard проверяет текущий settings snapshot схемы 11 и отвергает `sources.github` даже при отключённом источнике и отсутствии `gitlab.project`. Это происходит до writable Store. Setup больше не выбирает GitHub deployment по отсутствию GitLab-конфига. Проверены неизменность SQLite-файла и освобождение lock при отказе.
- После awaited entity/MR чтения источник повторно проверяет stop перед приёмом тела. Disable/abort не сохраняет событие как `source_disabled` и не продвигает непрочитанный checkpoint; после enable тот же TODO/stream принимается нормально.

Legacy core tests до P7 используют `tests/fixtures/legacy-runtime.ts` / `legacy-setup.ts`: старый setup и разрешение старого состояния доступны только явно зарегистрированным каталогам этих fixtures. GitLab runtime/tests и новые проверки отказа вызывают настоящий production guard без исключений. Production не импортирует эти fixtures.

Проверки после исправлений: typecheck/build успешны; 67 файлов / 1302 теста без service-script успешны. Полный check с таймаутом 60 секунд снова завершился exit 124; ограничение P7-04 сохраняется. Live API-проверки не выполнялись.

## Полный check после исправлений ревью (2026-11-15, 22:28)

По предоставленному пользователем выводу обычный `pnpm check` завершился успешно: typecheck, **68 файлов / 1317 тестов**, сборка client/index/gitlab-watch. Исключений тестов нет. `service-script.spec.ts` — **15/15**, 7.756 s; весь vitest — 9.02 s. Зависание в этом запуске не воспроизвелось. Это актуальный полный прогон; прежние таймауты агентского окружения выше остаются историческими наблюдениями, причина различия окружений не установлена.

Сборка выдала предупреждение о deprecated `tsgo` generator на TypeScript 7.0.2 (рекомендуется 7.1+); оно не помешало сборке. Зависимости в рамках фиксации результата не менялись. Live smoke, удаление legacy и повторный check после финальных изменений P7 остаются обязательными.

## 15. P6: установка, пакет и окружение проверок (2026-11-15)

Рабочие README/SETUP и docs/000–008 переведены на GitLab: host/project/agent, новый stateDir, TODOs + streams, Issue/MR keys, discussions, pipeline jobs и optional approvals. Merge и auto-merge не выполняются агентом. Оставшиеся упоминания прежних платформ в руководстве — отказ старого stateDir, исходная история и явно помеченные legacy-модули/тесты до P7; это не рабочие инструкции установки.

Npm name — `dsh-gitlab-superagent`, версия 0.1.0, private package; Cordis ID `dsh-superagent`, worker/router presets не менялись. Browser loader ID совпадает с npm name `dsh-gitlab-superagent` (исправлено после ревью P6); Cordis ID и panel namespace остаются `dsh-superagent`. Bundle patch загружает новый npm name и `/gitlab-watch`. Поиск packaged assets обновлён под новое имя. Offline lockfile validation прошла без обновления версий зависимостей. Tarball включает руководство, SETUP, wrapper/profile examples, service script, prompts/locales/GitLab skill и compiled exports. Тестовые fixtures и старые watch entry не поставляются; legacy runtime-код удаляется отдельно в P7.

Пример `examples/glab-agent.sh` проверен локальным fake-glab: абсолютный executable, отсутствие рекурсии через PATH shim, отдельный config/token file, подмена унаследованных операторских credentials/host, отказ от пустого token и запуска самого wrapper. Секреты не нужны для проверки. Реальная установка требует PAT api/write_repository и Maintainer, protected default branch, directory 0700 / token 0600. Обёртка не вызывает auth login/status и не меняет keyring. Произвольные TLS/proxy конфигурации и реальные 429 по-прежнему не проверены.

Диагностика прежних таймаутов service-script: минимальный `node:http` listener на `127.0.0.1` внутри ограниченного runner вернул **EPERM**. Старый helper ожидал успешного listen без error-handler, поэтому тест мог зависнуть. Такой же файл тестов вне sandbox прошёл (15/15 до дополнительной проверки deployment hint). Helper теперь отклоняет promise при listen error, а execFile timeout/spawn errors не превращаются в успешный exit 0. PID/lock/graceful stop/recovery assertions сохранены. Сервис — Python, поэтому проверка `bash -n` из первоначального плана заменена Python syntax validation; wrapper остаётся POSIX sh.

Полный P6 check выполняется с разрешёнными loopback listener, процессами и сигналами. Локальная tarball QA использует уже установленные peer dependencies через временную symlink, проверяет exports, asset loading и ошибку при отсутствующем packaged skill; это не чистая установка DSH и не live GitLab smoke. DSH CLI в окружении проверки отсутствует; установка по инструкции, clone/push, второй аккаунт, CI/approve/revoke/human merge и оба live-хоста остаются обязательной приёмкой P7-05/P7-06.


## 16. Исправления ревью P6 (2026-11-15)

Browser module ID отделён от Cordis entry ID: DSH ищет browser factory по resolved npm name, поэтому tsdown берёт ID из package.json. Сохраняются Cordis ID, presets и UI namespace, но browser factory регистрируется как dsh-gitlab-superagent. Tarball QA сравнивает регистрацию с packed.name; отдельная VM-регрессия проверяет именно lookup по npm name, а не только наличие старой регистрации.

Bootstrap wrapper теперь создаёт ~/.local/bin перед копированием. Регрессионный тест исполняет фактический блок install из Deployment guide с чистым временным HOME (включая пробелы) и проверяет содержимое wrapper и права приватного каталога/исполняемого файла. Оба исправления локальные; live DSH/GitLab не запускались.
