// Migrations, applied in order by migrate.ts. Never edit one that has shipped.

export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: /* sql */ `
      create function current_project() returns uuid
        language sql stable
        as $$ select nullif(current_setting('app.project_id', true), '')::uuid $$;

      create table projects (
        id uuid primary key,
        name text not null check (length(name) between 1 and 80),
        created_at timestamptz not null default now()
      );

      create table api_keys (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references projects (id) on delete cascade,
        key_hash bytea not null unique,
        prefix text not null,
        label text not null default '' check (length(label) <= 80),
        created_at timestamptz not null default now(),
        revoked_at timestamptz
      );
      create index api_keys_project on api_keys (project_id, created_at);

      create table runs (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references projects (id) on delete cascade,
        name text not null check (length(name) between 1 and 120),
        status text not null default 'running' check (status in ('running', 'finished', 'failed')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        finished_at timestamptz,
        -- The per-run delivery counter. It is only ever changed while this row
        -- is locked, and the lock is held until commit, so seq order is commit
        -- order for the run.
        last_seq bigint not null default 0,
        point_count bigint not null default 0,
        conflict_count bigint not null default 0,
        unique (id, project_id)
      );
      create index runs_project_created on runs (project_id, created_at desc, id);

      create table batches (
        run_id uuid not null,
        project_id uuid not null,
        batch_id uuid not null,
        payload_hash bytea not null,
        result jsonb not null,
        received_at timestamptz not null default now(),
        primary key (run_id, batch_id),
        foreign key (run_id, project_id) references runs (id, project_id) on delete cascade
      );

      -- The points table is also the event log: seq is the batch that
      -- introduced the point, and streams read "everything after seq n".
      create table points (
        run_id uuid not null,
        project_id uuid not null,
        key text not null,
        step bigint not null check (step >= 0),
        value double precision not null,
        seq bigint not null,
        primary key (run_id, key, step),
        foreign key (run_id, project_id) references runs (id, project_id) on delete cascade
      );
      create index points_run_seq on points (run_id, seq);

      -- Row-level security. FORCE applies it to the table owner too, and the
      -- application connects as simmer_app, which owns nothing.
      alter table projects enable row level security;
      alter table projects force row level security;
      create policy tenant on projects
        using (id = (select current_project()))
        with check (id = (select current_project()));

      alter table api_keys enable row level security;
      alter table api_keys force row level security;
      create policy tenant on api_keys
        using (project_id = (select current_project()))
        with check (project_id = (select current_project()));

      alter table runs enable row level security;
      alter table runs force row level security;
      create policy tenant on runs
        using (project_id = (select current_project()))
        with check (project_id = (select current_project()));

      alter table batches enable row level security;
      alter table batches force row level security;
      create policy tenant on batches
        using (project_id = (select current_project()))
        with check (project_id = (select current_project()));

      alter table points enable row level security;
      alter table points force row level security;
      create policy tenant on points
        using (project_id = (select current_project()))
        with check (project_id = (select current_project()));

      -- The only place that looks across projects: turning a key hash into
      -- its project before any project is known.
      create function auth_lookup(hash bytea)
        returns table (key_id uuid, project_id uuid)
        language sql stable security definer
        set search_path = public, pg_temp
        as $$
          select k.id, k.project_id from api_keys k
          where k.key_hash = hash and k.revoked_at is null
        $$;
      revoke all on function auth_lookup(bytea) from public;

      grant usage on schema public to simmer_app;
      grant execute on function auth_lookup(bytea) to simmer_app;
      grant execute on function current_project() to simmer_app;
      grant select, insert on projects to simmer_app;
      grant select, insert, update on api_keys to simmer_app;
      grant select, insert, update on runs to simmer_app;
      -- Stored points and batch records are facts. The application role can
      -- add them and read them, and has no way to change or remove them.
      grant select, insert on batches to simmer_app;
      grant select, insert on points to simmer_app;
    `,
  },
];
