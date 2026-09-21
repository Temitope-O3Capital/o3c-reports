-- Legacy baseline schema, for tests only. NOT a migration.
--
-- The migration chain cannot build this database from empty. It has only ever run
-- on top of tables the one-time MSSQL import created — app.accounts,
-- app.customers, app.transactions and friends are referenced by ~110 migrations
-- and created by none of them. Production also runs with search_path
-- "app, core, public" (set on the o3_app role), which is why 253 unqualified
-- CREATE TABLEs land in app there and in public on a fresh database.
--
-- This file provides just enough of that baseline for the integration tests to
-- have somewhere to stand. It is generated with:
--
--   pg_dump --schema-only --no-owner --no-acl --no-comments -t app.accounts ...
--
-- with foreign keys stripped (tests do not need referential integrity, and the
-- referenced tables are created later by migrations), and with functional indexes
-- removed: they call app.norm_phone, regexp_replace and app.gin_trgm_ops, which
-- migrations create after this file loads, and with ALL non-unique indexes removed:
-- they exist for query speed, which no test needs, and each one risked another
-- dependency on an extension, opclass or function created later. The five unique
-- indexes stay because migrations use ON CONFLICT against them. Regenerate it the same way
-- if a baseline table gains a column the handlers read.
--
-- It is deliberately NOT a migration: adding a 000_ file would put it in the
-- production boot sequence, and production already has these tables.

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS core;

--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4




--
-- Name: customers; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.customers (
    contact_id text CONSTRAINT customer_contact_id_not_null NOT NULL,
    cif text,
    full_name text,
    first_name text,
    last_name text,
    email text,
    phone text,
    address_1 text,
    address_2 text,
    full_address text,
    city text,
    state text,
    country text,
    birthday date,
    gender text,
    bvn text,
    account_status text,
    current_dr_limit numeric,
    available_balance numeric,
    account_created timestamp without time zone,
    created_at timestamp without time zone,
    cif_was_junk boolean,
    phone_was_fake boolean,
    email_was_malformed boolean,
    state_was_inferred boolean,
    state_method text,
    source text DEFAULT 'mssql_baseline'::text,
    source_file text,
    last_seen timestamp with time zone,
    job_title text,
    first_seen_at timestamp with time zone,
    party_id bigint,
    address_3 text,
    phone_2 text
);


--
-- Name: accounts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.accounts (
    account_id text CONSTRAINT account_account_id_not_null NOT NULL,
    account_no text,
    contact_id text,
    cif text,
    product_id smallint,
    product_name text,
    card_program text,
    card_pan text,
    name_on_card text,
    card_expiry_date date,
    card_limit numeric,
    current_dr_balance numeric,
    cycle_balance numeric,
    card_wd_available numeric,
    card_utilisation numeric,
    min_payment_due numeric,
    last_amount_paid numeric,
    opened_date date,
    last_payment_date date,
    payment_due_date date,
    status text,
    account_indicator text,
    days_overdue integer,
    collection_type text,
    cif_was_junk boolean,
    source text DEFAULT 'mssql_baseline'::text,
    source_file text,
    last_seen timestamp with time zone,
    card_product text,
    product_line text,
    currency_code text,
    status_code text,
    interest_rate numeric,
    card_issue_date date
);


--
-- Name: transactions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.transactions (
    txn_id text CONSTRAINT transaction_txn_id_not_null NOT NULL,
    account_id text,
    contact_id text,
    cif text,
    account_no text,
    post_date date,
    txn_date date,
    txn_code text,
    description text,
    amount numeric,
    amount_debit numeric,
    amount_credit numeric,
    account_balance numeric,
    money_in boolean,
    pan_number text,
    merchant_name text,
    mcc text,
    city text,
    trace text,
    product_name text,
    source text DEFAULT 'mssql_baseline'::text,
    source_file text,
    row_hash text,
    channel text,
    currency_code text,
    pcc text,
    code_class text
);


--
-- Name: call_center_campaigns; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.call_center_campaigns (
    id bigint CONSTRAINT telemarketing_campaigns_id_not_null NOT NULL,
    name text CONSTRAINT telemarketing_campaigns_name_not_null NOT NULL,
    status text DEFAULT 'active'::text CONSTRAINT telemarketing_campaigns_status_not_null NOT NULL,
    target_segment text,
    start_date date,
    end_date date,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT telemarketing_campaigns_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT telemarketing_campaigns_updated_at_not_null NOT NULL,
    purpose text,
    CONSTRAINT call_center_campaigns_purpose_chk CHECK (((purpose IS NULL) OR (purpose = ANY (ARRAY['collections'::text, 'marketing'::text, 'support'::text, 'retention'::text, 'other'::text]))))
);


--
-- Name: call_center_contacts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.call_center_contacts (
    id bigint CONSTRAINT telemarketing_contacts_id_not_null NOT NULL,
    customer_name text CONSTRAINT telemarketing_contacts_customer_name_not_null NOT NULL,
    phone text CONSTRAINT telemarketing_contacts_phone_not_null NOT NULL,
    cif text,
    product_name text,
    priority text DEFAULT 'Low'::text CONSTRAINT telemarketing_contacts_priority_not_null NOT NULL,
    outstanding_kobo bigint DEFAULT 0 CONSTRAINT telemarketing_contacts_outstanding_kobo_not_null NOT NULL,
    dpd integer DEFAULT 0 CONSTRAINT telemarketing_contacts_dpd_not_null NOT NULL,
    is_existing_customer boolean DEFAULT false CONSTRAINT telemarketing_contacts_is_existing_customer_not_null NOT NULL,
    loan_product text,
    next_payment_date date,
    last_disposition text,
    last_called_at timestamp with time zone,
    status text DEFAULT 'pending'::text CONSTRAINT telemarketing_contacts_status_not_null NOT NULL,
    assigned_to bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT telemarketing_contacts_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT telemarketing_contacts_updated_at_not_null NOT NULL,
    purpose text,
    source text,
    ref text,
    attempts integer DEFAULT 0 NOT NULL,
    connects integer DEFAULT 0 NOT NULL,
    last_call_outcome text,
    disposition_code text,
    callback_at timestamp with time zone,
    notes text,
    callback_notified_at timestamp with time zone,
    state text,
    party_id bigint,
    lead_id bigint,
    CONSTRAINT call_center_contacts_purpose_chk CHECK (((purpose IS NULL) OR (purpose = ANY (ARRAY['collections'::text, 'marketing'::text, 'sales'::text, 'support'::text, 'retention'::text, 'other'::text])))),
    CONSTRAINT call_center_contacts_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'skipped'::text, 'closed'::text, 'invalid'::text]))),
    CONSTRAINT telemarketing_contacts_priority_check CHECK ((priority = ANY (ARRAY['High'::text, 'Medium'::text, 'Low'::text])))
);


--
-- Name: call_center_dispositions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.call_center_dispositions (
    id bigint CONSTRAINT telemarketing_dispositions_id_not_null NOT NULL,
    lead_id bigint,
    agent_id bigint CONSTRAINT telemarketing_dispositions_agent_id_not_null NOT NULL,
    outcome text CONSTRAINT telemarketing_dispositions_outcome_not_null NOT NULL,
    notes text,
    duration_sec integer,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT telemarketing_dispositions_created_at_not_null NOT NULL,
    call_id bigint,
    contact_id bigint,
    CONSTRAINT call_center_dispositions_subject_chk CHECK (((lead_id IS NOT NULL) OR (contact_id IS NOT NULL)))
);


--
-- Name: call_center_leads; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.call_center_leads (
    id bigint CONSTRAINT telemarketing_leads_id_not_null NOT NULL,
    campaign_id bigint,
    customer_cif text,
    customer_name text CONSTRAINT telemarketing_leads_customer_name_not_null NOT NULL,
    customer_phone text,
    employer text,
    lead_score integer DEFAULT 0,
    status text DEFAULT 'pending'::text CONSTRAINT telemarketing_leads_status_not_null NOT NULL,
    assigned_to bigint,
    last_called_at timestamp with time zone,
    callback_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT telemarketing_leads_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT telemarketing_leads_updated_at_not_null NOT NULL,
    email text,
    address text,
    contact_id bigint,
    state text,
    last_disposition text,
    marketing_campaign_id bigint,
    source text,
    forwarded_at timestamp with time zone,
    party_id bigint,
    attempts integer DEFAULT 0 NOT NULL,
    connects integer DEFAULT 0 NOT NULL,
    CONSTRAINT call_center_leads_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'called'::text, 'interested'::text, 'not_ready'::text, 'callback'::text, 'no_answer'::text, 'converted'::text, 'closed'::text, 'invalid'::text, 'dnc'::text])))
);


--
-- Name: ccs_transactions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.ccs_transactions (
    id bigint CONSTRAINT interswitch_txns_id_not_null NOT NULL,
    trace_num text DEFAULT ''::text CONSTRAINT interswitch_txns_trace_num_not_null NOT NULL,
    auth_num text DEFAULT ''::text CONSTRAINT interswitch_txns_auth_num_not_null NOT NULL,
    card_num text DEFAULT ''::text CONSTRAINT interswitch_txns_card_num_not_null NOT NULL,
    txn_code text DEFAULT ''::text CONSTRAINT interswitch_txns_txn_code_not_null NOT NULL,
    txn_date date CONSTRAINT interswitch_txns_txn_date_not_null NOT NULL,
    merchant_id text DEFAULT ''::text CONSTRAINT interswitch_txns_merchant_id_not_null NOT NULL,
    amount_kobo bigint DEFAULT 0 CONSTRAINT interswitch_txns_amount_kobo_not_null NOT NULL,
    sign text DEFAULT ''::text CONSTRAINT interswitch_txns_sign_not_null NOT NULL,
    currency text DEFAULT ''::text CONSTRAINT interswitch_txns_currency_not_null NOT NULL,
    merchant_name text DEFAULT ''::text CONSTRAINT interswitch_txns_merchant_name_not_null NOT NULL,
    description text DEFAULT ''::text CONSTRAINT interswitch_txns_description_not_null NOT NULL,
    account_no text DEFAULT ''::text CONSTRAINT interswitch_txns_account_no_not_null NOT NULL,
    cif text DEFAULT ''::text CONSTRAINT interswitch_txns_cif_not_null NOT NULL,
    product_code text DEFAULT ''::text CONSTRAINT interswitch_txns_product_code_not_null NOT NULL,
    product_name text DEFAULT ''::text CONSTRAINT interswitch_txns_product_name_not_null NOT NULL,
    branch_code text DEFAULT ''::text CONSTRAINT interswitch_txns_branch_code_not_null NOT NULL,
    branch_name text DEFAULT ''::text CONSTRAINT interswitch_txns_branch_name_not_null NOT NULL,
    imported_at timestamp with time zone DEFAULT now() CONSTRAINT interswitch_txns_imported_at_not_null NOT NULL
);


--
-- Name: interswitch_txns_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

CREATE SEQUENCE app.interswitch_txns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: interswitch_txns_id_seq; Type: SEQUENCE OWNED BY; Schema: app; Owner: -
--

ALTER SEQUENCE app.interswitch_txns_id_seq OWNED BY app.ccs_transactions.id;


--
-- Name: telemarketing_campaigns_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

CREATE SEQUENCE app.telemarketing_campaigns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: telemarketing_campaigns_id_seq; Type: SEQUENCE OWNED BY; Schema: app; Owner: -
--

ALTER SEQUENCE app.telemarketing_campaigns_id_seq OWNED BY app.call_center_campaigns.id;


--
-- Name: telemarketing_contacts_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

CREATE SEQUENCE app.telemarketing_contacts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: telemarketing_contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: app; Owner: -
--

ALTER SEQUENCE app.telemarketing_contacts_id_seq OWNED BY app.call_center_contacts.id;


--
-- Name: telemarketing_dispositions_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

CREATE SEQUENCE app.telemarketing_dispositions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: telemarketing_dispositions_id_seq; Type: SEQUENCE OWNED BY; Schema: app; Owner: -
--

ALTER SEQUENCE app.telemarketing_dispositions_id_seq OWNED BY app.call_center_dispositions.id;


--
-- Name: telemarketing_leads_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

CREATE SEQUENCE app.telemarketing_leads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: telemarketing_leads_id_seq; Type: SEQUENCE OWNED BY; Schema: app; Owner: -
--

ALTER SEQUENCE app.telemarketing_leads_id_seq OWNED BY app.call_center_leads.id;


--
-- Name: zoho_sync_state; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.zoho_sync_state (
    job text NOT NULL,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_error text,
    last_imported integer DEFAULT 0
);


--
-- Name: product; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.product (
    product_id smallint NOT NULL,
    product_name text NOT NULL,
    product_code text,
    category text
);


--
-- Name: product_product_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.product ALTER COLUMN product_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME core.product_product_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: state_map; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.state_map (
    raw_state text NOT NULL,
    clean_state text,
    method text NOT NULL
);


--
-- Name: transaction; Type: VIEW; Schema: core; Owner: -
--



--
-- Name: call_center_campaigns id; Type: DEFAULT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.call_center_campaigns ALTER COLUMN id SET DEFAULT nextval('app.telemarketing_campaigns_id_seq'::regclass);


--
-- Name: call_center_contacts id; Type: DEFAULT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.call_center_contacts ALTER COLUMN id SET DEFAULT nextval('app.telemarketing_contacts_id_seq'::regclass);


--
-- Name: call_center_dispositions id; Type: DEFAULT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.call_center_dispositions ALTER COLUMN id SET DEFAULT nextval('app.telemarketing_dispositions_id_seq'::regclass);


--
-- Name: call_center_leads id; Type: DEFAULT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.call_center_leads ALTER COLUMN id SET DEFAULT nextval('app.telemarketing_leads_id_seq'::regclass);


--
-- Name: ccs_transactions id; Type: DEFAULT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ccs_transactions ALTER COLUMN id SET DEFAULT nextval('app.interswitch_txns_id_seq'::regclass);


--
-- Name: accounts account_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.accounts
    ADD CONSTRAINT account_pkey PRIMARY KEY (account_id);


--
-- Name: customers customer_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.customers
    ADD CONSTRAINT customer_pkey PRIMARY KEY (contact_id);


--
-- Name: ccs_transactions interswitch_txns_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ccs_transactions
    ADD CONSTRAINT interswitch_txns_pkey PRIMARY KEY (id);


--
-- Name: call_center_campaigns telemarketing_campaigns_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.call_center_campaigns
    ADD CONSTRAINT telemarketing_campaigns_pkey PRIMARY KEY (id);


--
-- Name: call_center_contacts telemarketing_contacts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.call_center_contacts
    ADD CONSTRAINT telemarketing_contacts_pkey PRIMARY KEY (id);


--
-- Name: call_center_dispositions telemarketing_dispositions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.call_center_dispositions
    ADD CONSTRAINT telemarketing_dispositions_pkey PRIMARY KEY (id);


--
-- Name: call_center_leads telemarketing_leads_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.call_center_leads
    ADD CONSTRAINT telemarketing_leads_pkey PRIMARY KEY (id);


--
-- Name: transactions transaction_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.transactions
    ADD CONSTRAINT transaction_pkey PRIMARY KEY (txn_id);


--
-- Name: zoho_sync_state zoho_sync_state_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.zoho_sync_state
    ADD CONSTRAINT zoho_sync_state_pkey PRIMARY KEY (job);


--
-- Name: product product_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.product
    ADD CONSTRAINT product_pkey PRIMARY KEY (product_id);


--
-- Name: product product_product_name_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.product
    ADD CONSTRAINT product_product_name_key UNIQUE (product_name);


--
-- Name: state_map state_map_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.state_map
    ADD CONSTRAINT state_map_pkey PRIMARY KEY (raw_state);


--
-- Name: account_account_no_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: account_cif_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: account_contact_id_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: account_product_id_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: call_center_leads_contact_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: customer_cif_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: customer_email_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: customer_state_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_accounts_currency_foreign; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_call_center_leads_phone10; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_contacts_assigned; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_contacts_callback; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_contacts_lead; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_contacts_normphone; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_contacts_party; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_contacts_serving; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_contacts_state; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_dispositions_call; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_dispositions_contact; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_leads_party; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_cc_leads_state; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_core_txn_cif_date; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_core_txn_trace; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_account_created; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_cif_trgm; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_email_trgm; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_first_seen; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_fullname_trgm; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_norm_phone; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_normphone; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_party_id; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_phone10; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_customers_phone_norm_trgm; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_is_txns_branch; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_is_txns_date; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_is_txns_product; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_tm_contacts_assigned; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_tm_contacts_phone; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_tm_contacts_status; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_tm_disp_agent; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_tm_disp_lead; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_tm_leads_assigned; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_tm_leads_campaign; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_tm_leads_status; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_transactions_account_no; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_transactions_account_no_date; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: idx_transactions_currency_foreign; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: transaction_account_id_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: transaction_cif_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: transaction_contact_id_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: transaction_mcc_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: transaction_row_hash_uidx; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX transaction_row_hash_uidx ON app.transactions USING btree (row_hash) WHERE (row_hash IS NOT NULL);


--
-- Name: transaction_txn_date_idx; Type: INDEX; Schema: app; Owner: -
--



--
-- Name: uq_accounts_account_no; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_accounts_account_no ON app.accounts USING btree (account_no) WHERE ((account_no IS NOT NULL) AND (account_no <> ''::text));


--
-- Name: uq_cc_leads_campaign_phone; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_cc_leads_campaign_phone ON app.call_center_leads USING btree (campaign_id, customer_phone) WHERE ((customer_phone IS NOT NULL) AND (customer_phone <> ''::text));


--
-- Name: uq_ccs_txn_natural; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_ccs_txn_natural ON app.ccs_transactions USING btree (trace_num, txn_date, branch_code, account_no, amount_kobo, sign, txn_code);


--
-- Name: uq_customers_cif; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_customers_cif ON app.customers USING btree (cif) WHERE ((cif IS NOT NULL) AND (cif <> ''::text));


--
-- Name: idx_state_map_upper_raw; Type: INDEX; Schema: core; Owner: -
--



--
-- Name: call_center_dispositions trg_activities_from_disposition; Type: TRIGGER; Schema: app; Owner: -
--



--
-- Name: call_center_contacts trg_stamp_cc_contact_party; Type: TRIGGER; Schema: app; Owner: -
--



--
-- Name: call_center_leads trg_stamp_cc_lead_party; Type: TRIGGER; Schema: app; Owner: -
--



--
-- Name: accounts account_contact_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: accounts account_product_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_contacts call_center_contacts_lead_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_contacts call_center_contacts_party_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_dispositions call_center_dispositions_call_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_dispositions call_center_dispositions_contact_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_leads call_center_leads_party_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: customers customers_party_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_campaigns telemarketing_campaigns_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_contacts telemarketing_contacts_assigned_to_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_dispositions telemarketing_dispositions_agent_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_dispositions telemarketing_dispositions_lead_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_leads telemarketing_leads_assigned_to_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: call_center_leads telemarketing_leads_campaign_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: transactions txn_account_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- Name: transactions txn_contact_fk; Type: FK CONSTRAINT; Schema: app; Owner: -
--



--
-- PostgreSQL database dump complete
--


