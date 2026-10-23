import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. Escrito à mão porque as garantias (unicidade, não-negatividade,
 * imutabilidade do ledger, estados terminais) precisam existir no banco — não
 * confio em DDL gerado para isso.
 */
export class Migration20261023000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id             uuid PRIMARY KEY,
        player_id      uuid NOT NULL,
        currency       char(3) NOT NULL,
        balance_amount numeric(18,2) NOT NULL,
        version        integer NOT NULL DEFAULT 1,
        created_at     timestamptz NOT NULL,
        updated_at     timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_currency_iso4217 CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text NOT NULL,
        external_transaction_id           text NOT NULL,
        idempotency_key                   text NOT NULL,
        payload_hash                      char(64) NOT NULL,
        wallet_id                         uuid NOT NULL REFERENCES wallets (id),
        player_id                         uuid NOT NULL,
        round_id                          text NOT NULL,
        game_id                           text NOT NULL,
        kind                              text NOT NULL,
        amount                            numeric(18,2) NOT NULL,
        currency                          char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid REFERENCES wager_transactions (id),
        status                            text NOT NULL,
        failure_code                      text,
        balance_after_amount              numeric(18,2),
        reference_attempts                integer NOT NULL DEFAULT 0,
        next_reference_retry_at           timestamptz,
        created_at                        timestamptz NOT NULL,
        processed_at                      timestamptz,
        updated_at                        timestamptz NOT NULL,
        CONSTRAINT wager_transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_kind_check
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_transactions_status_check
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_transactions_amount_positive CHECK (amount > 0),
        CONSTRAINT wager_transactions_balance_after_non_negative
          CHECK (balance_after_amount IS NULL OR balance_after_amount >= 0),
        -- REFUND/ROLLBACK sempre apontam para algo; os demais podem ou não.
        CONSTRAINT wager_transactions_reversal_has_reference
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        -- REJECTED/FAILED carregam o motivo; os demais não.
        CONSTRAINT wager_transactions_failure_code_matches_status
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        -- PROCESSED tem processed_at; os demais não.
        CONSTRAINT wager_transactions_processed_at_matches_status
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        -- Terminal ou pendente de referência: todos carregam o saldo observado.
        CONSTRAINT wager_transactions_observed_balance
          CHECK (status = 'PENDING' OR balance_after_amount IS NOT NULL),
        CONSTRAINT wager_transactions_reference_attempts_non_negative CHECK (reference_attempts >= 0)
      );
    `);

    // Uma referência só pode ser revertida uma vez (REFUND ou ROLLBACK que chegou a PROCESSED).
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_one_reversal_per_reference
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
    `);
    // Fila do worker de referências pendentes.
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_due
        ON wager_transactions (next_reference_retry_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    // "Quem está esperando por mim?" quando uma transação é processada.
    this.addSql(`
      CREATE INDEX wager_transactions_waiting_for_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_transactions_wallet_id ON wager_transactions (wallet_id, created_at);`);

    // Estados terminais não mudam. Qualquer UPDATE que altere algo numa linha
    // PROCESSED/REJECTED/FAILED é barrado aqui, mesmo que o código tente.
    this.addSql(`
      CREATE OR REPLACE FUNCTION forbid_terminal_transaction_mutation() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%) and cannot be modified', OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_terminal_guard
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_terminal_transaction_mutation();
    `);
    this.addSql(`
      CREATE OR REPLACE FUNCTION forbid_transaction_delete() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wager_transactions are append-only' USING ERRCODE = 'check_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete
        BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_transaction_delete();
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid PRIMARY KEY,
        wallet_id      uuid NOT NULL REFERENCES wallets (id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions (id),
        wallet_version integer NOT NULL,
        direction      text NOT NULL,
        amount         numeric(18,2) NOT NULL,
        currency       char(3) NOT NULL,
        balance_before numeric(18,2) NOT NULL,
        balance_after  numeric(18,2) NOT NULL,
        created_at     timestamptz NOT NULL,
        -- no máximo um lançamento por transação
        CONSTRAINT wallet_ledger_entries_transaction_unique UNIQUE (transaction_id),
        -- ordem total por wallet; também amarra 1 lançamento == 1 incremento de versão
        CONSTRAINT wallet_ledger_entries_wallet_version_unique UNIQUE (wallet_id, wallet_version),
        CONSTRAINT wallet_ledger_entries_direction_check CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_wallet_version_positive CHECK (wallet_version >= 1),
        -- balanceBefore ± amount == balanceAfter, verificado também pelo banco
        CONSTRAINT wallet_ledger_entries_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);

    // Ledger é append-only: nem UPDATE nem DELETE, nunca.
    this.addSql(`
      CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries are immutable (% not allowed)', TG_OP
          USING ERRCODE = 'check_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id    text NOT NULL,
        payload_hash  char(64) NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid PRIMARY KEY,
        aggregate_id    uuid NOT NULL,
        event_type      text NOT NULL,
        payload         jsonb NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0)
      );
    `);
    // Só as pendentes interessam ao publisher; índice parcial mantém a varredura barata.
    this.addSql(`
      CREATE INDEX outbox_messages_pending
        ON outbox_messages (next_attempt_at NULLS FIRST, occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entries_immutable ON wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_ledger_mutation();`);
    this.addSql(`DROP TRIGGER IF EXISTS wager_transactions_no_delete ON wager_transactions;`);
    this.addSql(`DROP TRIGGER IF EXISTS wager_transactions_terminal_guard ON wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_transaction_delete();`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_terminal_transaction_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
