# GitLab entity fixtures

Снято 2026-11-15 с self-managed GitLab **19.2.9** (`enterprise: false`, Free/CE), проект `tlcamp/human-resources` (id 25).

| Файл | Источник |
| --- | --- |
| `issue.json` | issue #1, созданный для P0 |
| `issue-notes.json` | notes issue #1, включая system note о назначении и комментарий project access token |
| `merge-request.json` | MR !1, `p0/mr-source` → `p0/credential-check` |
| `discussions.json` | discussion в MR !1 |
| `approval.json` | `GET /projects/25/merge_requests/1/approvals`; на Free только четыре поля |
| `pipeline.json` | pipeline 1179, ветка `p0/credential-check` |
| `jobs.json` | jobs pipeline 1179; job 12991 `p0-job` |
| `todo.json` | `GET /todos?project_id=25`; todo создан упоминанием от project access token |
| `user.json` | `GET /user`, email/имя заменены |
| `project.json` | `GET /projects/25`, удалён `runners_token` и служебные поля |
| `project-developer.json` | permissions проекта для project access token с access level 30 |
| `project-reporter.json` | permissions проекта для project access token с access level 20 |

## Что важно для схем

- `default_branch` в `project.json` — `p0/credential-check`, потому что проект был пуст и первая ветка стала default. В чистом проекте ожидается `main`.
- TODO: `target.iid` есть для Issue/MR, но не для всех `target_type`; нужен guard.
- Approval: `approvals_required` и `approvals_left` отсутствуют на Free; не делать их обязательными.
- `discussions.json`: `position` у обычного обсуждения `null`; для diff-обсуждений поле заполнено.
- `jobs.json`: в job есть `runner`/`runner_manager`; токенов в ответе нет.

## Санитизация

Удалены `runners_token`, `_links`, `ci_config_path`, `container_expiration_policy`, `namespace`, `shared_with_groups` в проекте; email/имя пользователя заменены; todo из других проектов не сохранялись. Токены project access token не сохранялись и были отозваны после снятия фикстур.
