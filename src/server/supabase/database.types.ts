
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "pdf_reader_evidence": {
              Row: { user_id: string; layout_hash: string; document_hash: string; created_at: string }
              ComputedFields: never
              Insert: { user_id: string; layout_hash: string; document_hash: string; created_at?: string }
              Update: { user_id?: string; layout_hash?: string; document_hash?: string; created_at?: string }
              Relationships: []
            }
            "account_balances": {
                  Row: {
                    "account_id": string,"as_of": string,"balance": number,"created_at": string,"currency": string,"document_id": string | null,"id": string,"source": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"as_of": string,"balance": number,"created_at"?: string,"currency": string,"document_id"?: string | null,"id"?: string,"source": string,"user_id"?: string
                  }
                  Update: {
                    "account_id"?: string,"as_of"?: string,"balance"?: number,"created_at"?: string,"currency"?: string,"document_id"?: string | null,"id"?: string,"source"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "account_balances_account_id_user_id_fkey"
      columns: ["account_id","user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "account_balances_currency_fkey"
      columns: ["currency"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "account_balances_document_id_user_id_fkey"
      columns: ["document_id","user_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"accounts": {
                  Row: {
                    "account_mask": string | null,"country": string | null,"created_at": string,"credit_limit": number | null,"currency": string,"entity_id": string,"external_ref_hash": string | null,"id": string,"include_in_net_worth": boolean,"institution_id": string | null,"is_archived": boolean,"last_synced_at": string | null,"name": string,"sync_source": string | null,"type": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_mask"?: string | null,"country"?: string | null,"created_at"?: string,"credit_limit"?: number | null,"currency": string,"entity_id": string,"external_ref_hash"?: string | null,"id"?: string,"include_in_net_worth"?: boolean,"institution_id"?: string | null,"is_archived"?: boolean,"last_synced_at"?: string | null,"name": string,"sync_source"?: string | null,"type": string,"updated_at"?: string,"user_id"?: string
                  }
                  Update: {
                    "account_mask"?: string | null,"country"?: string | null,"created_at"?: string,"credit_limit"?: number | null,"currency"?: string,"entity_id"?: string,"external_ref_hash"?: string | null,"id"?: string,"include_in_net_worth"?: boolean,"institution_id"?: string | null,"is_archived"?: boolean,"last_synced_at"?: string | null,"name"?: string,"sync_source"?: string | null,"type"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "accounts_currency_fkey"
      columns: ["currency"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "accounts_entity_id_user_id_fkey"
      columns: ["entity_id","user_id"]
isOneToOne: false
      referencedRelation: "financial_entities"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "accounts_institution_id_fkey"
      columns: ["institution_id"]
isOneToOne: false
      referencedRelation: "institutions"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_log": {
                  Row: {
                    "action": string,"actor": string,"created_at": string,"details": NonNullable<Json>,"id": number,"target_id": string | null,"target_table": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor": string,"created_at"?: string,"details"?: NonNullable<Json>,"id"?: never,"target_id"?: string | null,"target_table"?: string | null,"user_id": string
                  }
                  Update: {
                    "action"?: string,"actor"?: string,"created_at"?: string,"details"?: NonNullable<Json>,"id"?: never,"target_id"?: string | null,"target_table"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"blockchain_transactions": {
                  Row: {
                    "asset_id": string,"block_time": string,"classification": string,"counterparty": string | null,"created_at": string,"direction": string,"fee_quantity": number | null,"id": string,"log_index": number,"network": string,"quantity": number,"tx_hash": string,"user_id": string,"wallet_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "asset_id": string,"block_time": string,"classification"?: string,"counterparty"?: string | null,"created_at"?: string,"direction": string,"fee_quantity"?: number | null,"id"?: string,"log_index"?: number,"network": string,"quantity": number,"tx_hash": string,"user_id"?: string,"wallet_id": string
                  }
                  Update: {
                    "asset_id"?: string,"block_time"?: string,"classification"?: string,"counterparty"?: string | null,"created_at"?: string,"direction"?: string,"fee_quantity"?: number | null,"id"?: string,"log_index"?: number,"network"?: string,"quantity"?: number,"tx_hash"?: string,"user_id"?: string,"wallet_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "blockchain_transactions_asset_id_fkey"
      columns: ["asset_id"]
isOneToOne: false
      referencedRelation: "crypto_assets"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "blockchain_transactions_wallet_id_user_id_fkey"
      columns: ["wallet_id","user_id"]
isOneToOne: false
      referencedRelation: "crypto_wallets"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"categories": {
                  Row: {
                    "created_at": string,"hue": number | null,"icon": string | null,"id": string,"kind": string,"name": string | null,"slug": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"hue"?: number | null,"icon"?: string | null,"id"?: string,"kind": string,"name"?: string | null,"slug": string,"user_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"hue"?: number | null,"icon"?: string | null,"id"?: string,"kind"?: string,"name"?: string | null,"slug"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"categorization_rules": {
                  Row: {
                    "category_id": string,"created_at": string,"direction": string | null,"hits": number,"id": string,"last_hit_at": string | null,"match_type": string,"merchant": string | null,"pattern": string,"priority": number,"source": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id": string,"created_at"?: string,"direction"?: string | null,"hits"?: number,"id"?: string,"last_hit_at"?: string | null,"match_type": string,"merchant"?: string | null,"pattern": string,"priority"?: number,"source": string,"user_id"?: string | null
                  }
                  Update: {
                    "category_id"?: string,"created_at"?: string,"direction"?: string | null,"hits"?: number,"id"?: string,"last_hit_at"?: string | null,"match_type"?: string,"merchant"?: string | null,"pattern"?: string,"priority"?: number,"source"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "categorization_rules_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    }
                  ]
                },"crypto_assets": {
                  Row: {
                    "contract_address": string | null,"created_at": string,"currency_code": string | null,"decimals": number,"id": string,"is_stablecoin": boolean,"name": string,"network": string,"symbol": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contract_address"?: string | null,"created_at"?: string,"currency_code"?: string | null,"decimals": number,"id"?: string,"is_stablecoin"?: boolean,"name": string,"network": string,"symbol": string
                  }
                  Update: {
                    "contract_address"?: string | null,"created_at"?: string,"currency_code"?: string | null,"decimals"?: number,"id"?: string,"is_stablecoin"?: boolean,"name"?: string,"network"?: string,"symbol"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "crypto_assets_currency_code_fkey"
      columns: ["currency_code"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    }
                  ]
                },"crypto_wallets": {
                  Row: {
                    "account_id": string,"created_at": string,"family": string,"id": string,"label": string | null,"last_synced_at": string | null,"networks": (string)[],"public_identifier": string,"sync_error": string | null,"sync_status": string,"user_id": string,"watch_kind": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"created_at"?: string,"family": string,"id"?: string,"label"?: string | null,"last_synced_at"?: string | null,"networks"?: (string)[],"public_identifier": string,"sync_error"?: string | null,"sync_status"?: string,"user_id"?: string,"watch_kind": string
                  }
                  Update: {
                    "account_id"?: string,"created_at"?: string,"family"?: string,"id"?: string,"label"?: string | null,"last_synced_at"?: string | null,"networks"?: (string)[],"public_identifier"?: string,"sync_error"?: string | null,"sync_status"?: string,"user_id"?: string,"watch_kind"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "crypto_wallets_account_id_user_id_fkey"
      columns: ["account_id","user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"currencies": {
                  Row: {
                    "code": string,"decimals": number,"display_decimals": number,"kind": string,"name": string,"pegged_to": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"decimals": number,"display_decimals": number,"kind": string,"name": string,"pegged_to"?: string | null
                  }
                  Update: {
                    "code"?: string,"decimals"?: number,"display_decimals"?: number,"kind"?: string,"name"?: string,"pegged_to"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "currencies_pegged_to_fkey"
      columns: ["pegged_to"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    }
                  ]
                },"documents": {
                  Row: {
                    "created_at": string,"detected_format": string | null,"detected_institution_id": string | null,"id": string,"mime_type": string,"original_filename": string,"period_end": string | null,"period_start": string | null,"sha256": string,"size_bytes": number,"status": string,"storage_path": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"detected_format"?: string | null,"detected_institution_id"?: string | null,"id"?: string,"mime_type": string,"original_filename": string,"period_end"?: string | null,"period_start"?: string | null,"sha256": string,"size_bytes": number,"status"?: string,"storage_path": string,"user_id"?: string
                  }
                  Update: {
                    "created_at"?: string,"detected_format"?: string | null,"detected_institution_id"?: string | null,"id"?: string,"mime_type"?: string,"original_filename"?: string,"period_end"?: string | null,"period_start"?: string | null,"sha256"?: string,"size_bytes"?: number,"status"?: string,"storage_path"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "documents_detected_institution_id_fkey"
      columns: ["detected_institution_id"]
isOneToOne: false
      referencedRelation: "institutions"
      referencedColumns: ["id"]
    }
                  ]
                },"exchange_rates": {
                  Row: {
                    "as_of": string,"base": string,"fetched_at": string,"quote": string,"rate": number,"source": string
                  }
                  ComputedFields: never
                  Insert: {
                    "as_of": string,"base": string,"fetched_at"?: string,"quote": string,"rate": number,"source": string
                  }
                  Update: {
                    "as_of"?: string,"base"?: string,"fetched_at"?: string,"quote"?: string,"rate"?: number,"source"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "exchange_rates_base_fkey"
      columns: ["base"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "exchange_rates_quote_fkey"
      columns: ["quote"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    }
                  ]
                },"financial_entities": {
                  Row: {
                    "country": string | null,"created_at": string,"id": string,"kind": string,"name": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "country"?: string | null,"created_at"?: string,"id"?: string,"kind": string,"name": string,"updated_at"?: string,"user_id"?: string
                  }
                  Update: {
                    "country"?: string | null,"created_at"?: string,"id"?: string,"kind"?: string,"name"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"import_jobs": {
                  Row: {
                    "ai_provider": string | null,"attempt": number,"created_at": string,"document_id": string,"error_code": string | null,"error_message": string | null,"finished_at": string | null,"id": string,"progress": number,"stage": string,"started_at": string | null,"stats": NonNullable<Json>,"status": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_provider"?: string | null,"attempt"?: number,"created_at"?: string,"document_id": string,"error_code"?: string | null,"error_message"?: string | null,"finished_at"?: string | null,"id"?: string,"progress"?: number,"stage"?: string,"started_at"?: string | null,"stats"?: NonNullable<Json>,"status"?: string,"user_id"?: string
                  }
                  Update: {
                    "ai_provider"?: string | null,"attempt"?: number,"created_at"?: string,"document_id"?: string,"error_code"?: string | null,"error_message"?: string | null,"finished_at"?: string | null,"id"?: string,"progress"?: number,"stage"?: string,"started_at"?: string | null,"stats"?: NonNullable<Json>,"status"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_jobs_document_id_user_id_fkey"
      columns: ["document_id","user_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"inbox_items": {
                  Row: {
                    "account_id": string | null,"created_at": string,"dedupe_key": string,"document_id": string | null,"id": string,"kind": string,"payload": NonNullable<Json>,"priority": number,"recurring_series_id": string | null,"resolution": Json | null,"resolved_at": string | null,"status": string,"transaction_ids": (string)[],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id"?: string | null,"created_at"?: string,"dedupe_key": string,"document_id"?: string | null,"id"?: string,"kind": string,"payload"?: NonNullable<Json>,"priority"?: number,"recurring_series_id"?: string | null,"resolution"?: Json | null,"resolved_at"?: string | null,"status"?: string,"transaction_ids"?: (string)[],"user_id"?: string
                  }
                  Update: {
                    "account_id"?: string | null,"created_at"?: string,"dedupe_key"?: string,"document_id"?: string | null,"id"?: string,"kind"?: string,"payload"?: NonNullable<Json>,"priority"?: number,"recurring_series_id"?: string | null,"resolution"?: Json | null,"resolved_at"?: string | null,"status"?: string,"transaction_ids"?: (string)[],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "inbox_items_account_id_user_id_fkey"
      columns: ["account_id","user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "inbox_items_document_id_user_id_fkey"
      columns: ["document_id","user_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "inbox_items_recurring_series_id_user_id_fkey"
      columns: ["recurring_series_id","user_id"]
isOneToOne: false
      referencedRelation: "recurring_series"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"insights": {
                  Row: {
                    "dismissed_at": string | null,"evidence": NonNullable<Json>,"fingerprint": string,"generated_at": string,"id": string,"kind": string,"params": NonNullable<Json>,"period_end": string | null,"period_start": string | null,"severity": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "dismissed_at"?: string | null,"evidence"?: NonNullable<Json>,"fingerprint": string,"generated_at"?: string,"id"?: string,"kind": string,"params"?: NonNullable<Json>,"period_end"?: string | null,"period_start"?: string | null,"severity"?: string,"user_id"?: string
                  }
                  Update: {
                    "dismissed_at"?: string | null,"evidence"?: NonNullable<Json>,"fingerprint"?: string,"generated_at"?: string,"id"?: string,"kind"?: string,"params"?: NonNullable<Json>,"period_end"?: string | null,"period_start"?: string | null,"severity"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"institutions": {
                  Row: {
                    "aliases": (string)[],"bic": string | null,"brand_color": string | null,"country": string | null,"created_at": string,"id": string,"kind": string,"name": string,"owner_id": string | null,"slug": string
                  }
                  ComputedFields: never
                  Insert: {
                    "aliases"?: (string)[],"bic"?: string | null,"brand_color"?: string | null,"country"?: string | null,"created_at"?: string,"id"?: string,"kind"?: string,"name": string,"owner_id"?: string | null,"slug": string
                  }
                  Update: {
                    "aliases"?: (string)[],"bic"?: string | null,"brand_color"?: string | null,"country"?: string | null,"created_at"?: string,"id"?: string,"kind"?: string,"name"?: string,"owner_id"?: string | null,"slug"?: string
                  }
                  Relationships: [
                    
                  ]
                },"liability_details": {
                  Row: {
                    "account_id": string,"interest_rate_apr": number | null,"maturity_on": string | null,"monthly_payment": number | null,"original_principal": number | null,"started_on": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"interest_rate_apr"?: number | null,"maturity_on"?: string | null,"monthly_payment"?: number | null,"original_principal"?: number | null,"started_on"?: string | null,"user_id"?: string
                  }
                  Update: {
                    "account_id"?: string,"interest_rate_apr"?: number | null,"maturity_on"?: string | null,"monthly_payment"?: number | null,"original_principal"?: number | null,"started_on"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "liability_details_account_id_user_id_fkey"
      columns: ["account_id","user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "ai_cloud_consent": boolean,"created_at": string,"display_name": string | null,"id": string,"include_business_in_net_worth": boolean,"locale": string,"primary_currency": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_cloud_consent"?: boolean,"created_at"?: string,"display_name"?: string | null,"id": string,"include_business_in_net_worth"?: boolean,"locale"?: string,"primary_currency"?: string,"updated_at"?: string
                  }
                  Update: {
                    "ai_cloud_consent"?: boolean,"created_at"?: string,"display_name"?: string | null,"id"?: string,"include_business_in_net_worth"?: boolean,"locale"?: string,"primary_currency"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_primary_currency_fkey"
      columns: ["primary_currency"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    }
                  ]
                },"recurring_series": {
                  Row: {
                    "account_id": string | null,"average_amount": number,"cadence": string,"category_id": string | null,"created_at": string,"currency": string,"detection_confidence": number | null,"fingerprint": string,"first_seen_on": string,"id": string,"is_subscription": boolean,"last_amount": number,"last_seen_on": string,"merchant": string,"next_expected_on": string | null,"occurrences": number,"status": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id"?: string | null,"average_amount": number,"cadence": string,"category_id"?: string | null,"created_at"?: string,"currency": string,"detection_confidence"?: number | null,"fingerprint": string,"first_seen_on": string,"id"?: string,"is_subscription"?: boolean,"last_amount": number,"last_seen_on": string,"merchant": string,"next_expected_on"?: string | null,"occurrences": number,"status"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Update: {
                    "account_id"?: string | null,"average_amount"?: number,"cadence"?: string,"category_id"?: string | null,"created_at"?: string,"currency"?: string,"detection_confidence"?: number | null,"fingerprint"?: string,"first_seen_on"?: string,"id"?: string,"is_subscription"?: boolean,"last_amount"?: number,"last_seen_on"?: string,"merchant"?: string,"next_expected_on"?: string | null,"occurrences"?: number,"status"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "recurring_series_account_id_user_id_fkey"
      columns: ["account_id","user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "recurring_series_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recurring_series_currency_fkey"
      columns: ["currency"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    }
                  ]
                },"transactions": {
                  Row: {
                    "account_id": string,"amount": number,"booked_on": string,"category_confidence": number | null,"category_id": string | null,"category_source": string | null,"classification": string,"counterpart_transaction_id": string | null,"created_at": string,"currency": string,"description_clean": string | null,"description_original": string,"document_id": string | null,"duplicate_of": string | null,"external_id": string | null,"extraction": string | null,"fingerprint": string,"fx_rate": number | null,"id": string,"import_job_id": string | null,"merchant": string | null,"notes": string | null,"original_amount": number | null,"original_currency": string | null,"raw": Json | null,"recurring_series_id": string | null,"source": string,"source_row": number | null,"status": string,"transfer_group_id": string | null,"updated_at": string,"user_id": string,"value_on": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"amount": number,"booked_on": string,"category_confidence"?: number | null,"category_id"?: string | null,"category_source"?: string | null,"classification"?: string,"counterpart_transaction_id"?: string | null,"created_at"?: string,"currency": string,"description_clean"?: string | null,"description_original": string,"document_id"?: string | null,"duplicate_of"?: string | null,"external_id"?: string | null,"extraction"?: string | null,"fingerprint": string,"fx_rate"?: number | null,"id"?: string,"import_job_id"?: string | null,"merchant"?: string | null,"notes"?: string | null,"original_amount"?: number | null,"original_currency"?: string | null,"raw"?: Json | null,"recurring_series_id"?: string | null,"source": string,"source_row"?: number | null,"status"?: string,"transfer_group_id"?: string | null,"updated_at"?: string,"user_id"?: string,"value_on"?: string | null
                  }
                  Update: {
                    "account_id"?: string,"amount"?: number,"booked_on"?: string,"category_confidence"?: number | null,"category_id"?: string | null,"category_source"?: string | null,"classification"?: string,"counterpart_transaction_id"?: string | null,"created_at"?: string,"currency"?: string,"description_clean"?: string | null,"description_original"?: string,"document_id"?: string | null,"duplicate_of"?: string | null,"external_id"?: string | null,"extraction"?: string | null,"fingerprint"?: string,"fx_rate"?: number | null,"id"?: string,"import_job_id"?: string | null,"merchant"?: string | null,"notes"?: string | null,"original_amount"?: number | null,"original_currency"?: string | null,"raw"?: Json | null,"recurring_series_id"?: string | null,"source"?: string,"source_row"?: number | null,"status"?: string,"transfer_group_id"?: string | null,"updated_at"?: string,"user_id"?: string,"value_on"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "transactions_account_id_user_id_fkey"
      columns: ["account_id","user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "transactions_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_counterpart_transaction_id_user_id_fkey"
      columns: ["counterpart_transaction_id","user_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "transactions_currency_fkey"
      columns: ["currency"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "transactions_document_id_user_id_fkey"
      columns: ["document_id","user_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "transactions_duplicate_of_user_id_fkey"
      columns: ["duplicate_of","user_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "transactions_import_job_id_user_id_fkey"
      columns: ["import_job_id","user_id"]
isOneToOne: false
      referencedRelation: "import_jobs"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "transactions_original_currency_fkey"
      columns: ["original_currency"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "transactions_recurring_series_id_user_id_fkey"
      columns: ["recurring_series_id","user_id"]
isOneToOne: false
      referencedRelation: "recurring_series"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"wallet_holdings": {
                  Row: {
                    "as_of": string,"asset_id": string,"created_at": string,"id": string,"quantity": number,"user_id": string,"wallet_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "as_of": string,"asset_id": string,"created_at"?: string,"id"?: string,"quantity": number,"user_id"?: string,"wallet_id": string
                  }
                  Update: {
                    "as_of"?: string,"asset_id"?: string,"created_at"?: string,"id"?: string,"quantity"?: number,"user_id"?: string,"wallet_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wallet_holdings_asset_id_fkey"
      columns: ["asset_id"]
isOneToOne: false
      referencedRelation: "crypto_assets"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wallet_holdings_wallet_id_user_id_fkey"
      columns: ["wallet_id","user_id"]
isOneToOne: false
      referencedRelation: "crypto_wallets"
      referencedColumns: ["id","user_id"]
    }
                  ]
                }
          }
          Views: {
            "account_latest_balances": {
                  Row: {
                    "account_id": string | null,"as_of": string | null,"balance": number | null,"currency": string | null,"source": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "account_balances_account_id_user_id_fkey"
      columns: ["account_id","user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "account_balances_currency_fkey"
      columns: ["currency"]
isOneToOne: false
      referencedRelation: "currencies"
      referencedColumns: ["code"]
    }
                  ]
                },"wallet_latest_holdings": {
                  Row: {
                    "as_of": string | null,"asset_id": string | null,"quantity": number | null,"user_id": string | null,"wallet_id": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "wallet_holdings_asset_id_fkey"
      columns: ["asset_id"]
isOneToOne: false
      referencedRelation: "crypto_assets"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wallet_holdings_wallet_id_user_id_fkey"
      columns: ["wallet_id","user_id"]
isOneToOne: false
      referencedRelation: "crypto_wallets"
      referencedColumns: ["id","user_id"]
    }
                  ]
                }
          }
          Functions: {
            "apply_transaction_updates":
{ Args: { "p_updates": Json }; Returns: number
                           },
"delete_my_financial_data":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"log_user_action":
{ Args: { "p_action": string,"p_details": Json,"p_target_id": string,"p_target_table": string }; Returns: undefined
                           },
"record_rule_hits":
{ Args: { "p_rule_ids": (string)[] }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
