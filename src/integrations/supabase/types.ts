export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      access_requests: {
        Row: {
          association: string | null
          created_at: string
          email: string
          full_name: string | null
          globus_name: string | null
          globus_subject: string | null
          id: string
          institution: string | null
          message: string | null
          requested_role: string | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          association?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          globus_name?: string | null
          globus_subject?: string | null
          id?: string
          institution?: string | null
          message?: string | null
          requested_role?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          association?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          globus_name?: string | null
          globus_subject?: string | null
          id?: string
          institution?: string | null
          message?: string | null
          requested_role?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      allowed_domains: {
        Row: {
          created_at: string
          domain: string
          id: string
          organization_id: string
        }
        Insert: {
          created_at?: string
          domain: string
          id?: string
          organization_id: string
        }
        Update: {
          created_at?: string
          domain?: string
          id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "allowed_domains_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_clicks: {
        Row: {
          created_at: string
          element_href: string | null
          element_tag: string | null
          element_text: string | null
          id: string
          organization_id: string | null
          path: string
          section: string | null
          session_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          element_href?: string | null
          element_tag?: string | null
          element_text?: string | null
          id?: string
          organization_id?: string | null
          path: string
          section?: string | null
          session_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          element_href?: string | null
          element_tag?: string | null
          element_text?: string | null
          id?: string
          organization_id?: string | null
          path?: string
          section?: string | null
          session_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analytics_clicks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_pageviews: {
        Row: {
          created_at: string
          id: string
          organization_id: string | null
          path: string
          referrer: string | null
          session_id: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id?: string | null
          path: string
          referrer?: string | null
          session_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string | null
          path?: string
          referrer?: string | null
          session_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analytics_pageviews_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          content: string
          created_at: string
          id: string
          is_external_link: boolean
          link: string | null
          link_text: string | null
          organization_id: string | null
          posted_by: string | null
          resource_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          is_external_link?: boolean
          link?: string | null
          link_text?: string | null
          organization_id?: string | null
          posted_by?: string | null
          resource_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          is_external_link?: boolean
          link?: string | null
          link_text?: string | null
          organization_id?: string | null
          posted_by?: string | null
          resource_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcements_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      auth_audit_log: {
        Row: {
          attempted_email: string | null
          created_at: string
          error_reason: string
          globus_name: string | null
          id: string
          ip_address: string | null
          metadata: Json | null
        }
        Insert: {
          attempted_email?: string | null
          created_at?: string
          error_reason: string
          globus_name?: string | null
          id?: string
          ip_address?: string | null
          metadata?: Json | null
        }
        Update: {
          attempted_email?: string | null
          created_at?: string
          error_reason?: string
          globus_name?: string | null
          id?: string
          ip_address?: string | null
          metadata?: Json | null
        }
        Relationships: []
      }
      budget_config: {
        Row: {
          alert_threshold_pct: number
          config: Json
          created_at: string
          id: string
          last_sync_error: string | null
          last_sync_status: string | null
          last_synced_at: string | null
          manual_notes: string | null
          manual_usage_usd: number | null
          monthly_limit_usd: number
          provider: Database["public"]["Enums"]["budget_provider"]
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          alert_threshold_pct?: number
          config?: Json
          created_at?: string
          id?: string
          last_sync_error?: string | null
          last_sync_status?: string | null
          last_synced_at?: string | null
          manual_notes?: string | null
          manual_usage_usd?: number | null
          monthly_limit_usd?: number
          provider: Database["public"]["Enums"]["budget_provider"]
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          alert_threshold_pct?: number
          config?: Json
          created_at?: string
          id?: string
          last_sync_error?: string | null
          last_sync_status?: string | null
          last_synced_at?: string | null
          manual_notes?: string | null
          manual_usage_usd?: number | null
          monthly_limit_usd?: number
          provider?: Database["public"]["Enums"]["budget_provider"]
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      budget_snapshots: {
        Row: {
          captured_at: string
          created_at: string
          id: string
          metric_key: string
          metric_label: string | null
          period_end: string | null
          period_start: string | null
          provider: Database["public"]["Enums"]["budget_provider"]
          raw: Json
          unit: string | null
          value_numeric: number | null
        }
        Insert: {
          captured_at?: string
          created_at?: string
          id?: string
          metric_key: string
          metric_label?: string | null
          period_end?: string | null
          period_start?: string | null
          provider: Database["public"]["Enums"]["budget_provider"]
          raw?: Json
          unit?: string | null
          value_numeric?: number | null
        }
        Update: {
          captured_at?: string
          created_at?: string
          id?: string
          metric_key?: string
          metric_label?: string | null
          period_end?: string | null
          period_start?: string | null
          provider?: Database["public"]["Enums"]["budget_provider"]
          raw?: Json
          unit?: string | null
          value_numeric?: number | null
        }
        Relationships: []
      }
      cohort_summaries: {
        Row: {
          created_at: string
          generated_at: string
          mechanism: string
          n_grants: number
          summary: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          generated_at?: string
          mechanism: string
          n_grants?: number
          summary: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          generated_at?: string
          mechanism?: string
          n_grants?: number
          summary?: string
          updated_at?: string
        }
        Relationships: []
      }
      curation_audit_log: {
        Row: {
          action: Database["public"]["Enums"]["curation_action"]
          actor_id: string | null
          after_value: Json | null
          before_value: Json | null
          created_at: string
          entity_id: string | null
          entity_type: Database["public"]["Enums"]["curation_entity_type"]
          field_name: string | null
          grant_number: string | null
          id: string
          investigator_id: string | null
          is_revert: boolean
          project_id: string | null
          resource_id: string | null
          reverted_at: string | null
          reverted_by: string | null
          reverted_from_audit_id: string | null
          source: string
        }
        Insert: {
          action: Database["public"]["Enums"]["curation_action"]
          actor_id?: string | null
          after_value?: Json | null
          before_value?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type: Database["public"]["Enums"]["curation_entity_type"]
          field_name?: string | null
          grant_number?: string | null
          id?: string
          investigator_id?: string | null
          is_revert?: boolean
          project_id?: string | null
          resource_id?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          reverted_from_audit_id?: string | null
          source?: string
        }
        Update: {
          action?: Database["public"]["Enums"]["curation_action"]
          actor_id?: string | null
          after_value?: Json | null
          before_value?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: Database["public"]["Enums"]["curation_entity_type"]
          field_name?: string | null
          grant_number?: string | null
          id?: string
          investigator_id?: string | null
          is_revert?: boolean
          project_id?: string | null
          resource_id?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          reverted_from_audit_id?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "curation_audit_log_reverted_from_audit_id_fkey"
            columns: ["reverted_from_audit_id"]
            isOneToOne: false
            referencedRelation: "curation_audit_log"
            referencedColumns: ["id"]
          },
        ]
      }
      dandisets: {
        Row: {
          access: string | null
          api_url: string | null
          award_numbers: string[] | null
          contact_name: string | null
          created_at: string
          dandiset_id: string
          description: string | null
          draft_url: string | null
          file_count: number | null
          id: string
          instance: string
          last_synced_at: string
          license: string | null
          name: string
          neurosift_url: string | null
          raw: Json
          resource_id: string | null
          size_bytes: number | null
          species: string[] | null
          updated_at: string
        }
        Insert: {
          access?: string | null
          api_url?: string | null
          award_numbers?: string[] | null
          contact_name?: string | null
          created_at?: string
          dandiset_id: string
          description?: string | null
          draft_url?: string | null
          file_count?: number | null
          id?: string
          instance?: string
          last_synced_at?: string
          license?: string | null
          name: string
          neurosift_url?: string | null
          raw?: Json
          resource_id?: string | null
          size_bytes?: number | null
          species?: string[] | null
          updated_at?: string
        }
        Update: {
          access?: string | null
          api_url?: string | null
          award_numbers?: string[] | null
          contact_name?: string | null
          created_at?: string
          dandiset_id?: string
          description?: string | null
          draft_url?: string | null
          file_count?: number | null
          id?: string
          instance?: string
          last_synced_at?: string
          license?: string | null
          name?: string
          neurosift_url?: string | null
          raw?: Json
          resource_id?: string | null
          size_bytes?: number | null
          species?: string[] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dandisets_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      data_audit_log: {
        Row: {
          actor_id: string | null
          actor_label: string | null
          actor_role: string | null
          changed_fields: Json | null
          client_source: string | null
          id: number
          new_data: Json | null
          occurred_at: string
          old_data: Json | null
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          actor_id?: string | null
          actor_label?: string | null
          actor_role?: string | null
          changed_fields?: Json | null
          client_source?: string | null
          id?: never
          new_data?: Json | null
          occurred_at?: string
          old_data?: Json | null
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          actor_id?: string | null
          actor_label?: string | null
          actor_role?: string | null
          changed_fields?: Json | null
          client_source?: string | null
          id?: never
          new_data?: Json | null
          occurred_at?: string
          old_data?: Json | null
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      device_categories: {
        Row: {
          created_at: string
          description: string | null
          id: string
          key: string
          label: string
          measures: string[]
          resource_id: string | null
          schema_org_type: string | null
          typical_use_cases: string[]
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          key: string
          label: string
          measures?: string[]
          resource_id?: string | null
          schema_org_type?: string | null
          typical_use_cases?: string[]
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          label?: string
          measures?: string[]
          resource_id?: string | null
          schema_org_type?: string | null
          typical_use_cases?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_categories_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      device_category_ml_specs: {
        Row: {
          category_key: string
          common_models: string[]
          created_at: string
          dataset_examples: string[]
          feature_set: string[]
          id: string
          input_signal: string | null
          label_source: string | null
          notes: string | null
          preprocessing: string[]
          sampling_rate_hz: number | null
          task: string
          updated_at: string
        }
        Insert: {
          category_key: string
          common_models?: string[]
          created_at?: string
          dataset_examples?: string[]
          feature_set?: string[]
          id?: string
          input_signal?: string | null
          label_source?: string | null
          notes?: string | null
          preprocessing?: string[]
          sampling_rate_hz?: number | null
          task: string
          updated_at?: string
        }
        Update: {
          category_key?: string
          common_models?: string[]
          created_at?: string
          dataset_examples?: string[]
          feature_set?: string[]
          id?: string
          input_signal?: string | null
          label_source?: string | null
          notes?: string | null
          preprocessing?: string[]
          sampling_rate_hz?: number | null
          task?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_category_ml_specs_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "device_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "device_category_ml_specs_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "project_device_usage"
            referencedColumns: ["category_key"]
          },
        ]
      }
      device_category_parameters: {
        Row: {
          category_key: string
          created_at: string
          id: string
          name: string
          notes: string | null
          standard_ref: string | null
          symbol: string | null
          typical_range: string | null
          unit: string | null
          updated_at: string
          window_spec: string | null
        }
        Insert: {
          category_key: string
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          standard_ref?: string | null
          symbol?: string | null
          typical_range?: string | null
          unit?: string | null
          updated_at?: string
          window_spec?: string | null
        }
        Update: {
          category_key?: string
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          standard_ref?: string | null
          symbol?: string | null
          typical_range?: string | null
          unit?: string | null
          updated_at?: string
          window_spec?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "device_category_parameters_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "device_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "device_category_parameters_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "project_device_usage"
            referencedColumns: ["category_key"]
          },
        ]
      }
      device_category_pitfalls: {
        Row: {
          category_key: string
          created_at: string
          id: string
          issue: string
          mitigation: string | null
          severity: string
          updated_at: string
        }
        Insert: {
          category_key: string
          created_at?: string
          id?: string
          issue: string
          mitigation?: string | null
          severity?: string
          updated_at?: string
        }
        Update: {
          category_key?: string
          created_at?: string
          id?: string
          issue?: string
          mitigation?: string | null
          severity?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_category_pitfalls_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "device_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "device_category_pitfalls_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "project_device_usage"
            referencedColumns: ["category_key"]
          },
        ]
      }
      device_category_references: {
        Row: {
          authority: string | null
          category_key: string
          created_at: string
          doi: string | null
          id: string
          kind: string
          title: string
          updated_at: string
          url: string | null
          year: number | null
        }
        Insert: {
          authority?: string | null
          category_key: string
          created_at?: string
          doi?: string | null
          id?: string
          kind: string
          title: string
          updated_at?: string
          url?: string | null
          year?: number | null
        }
        Update: {
          authority?: string | null
          category_key?: string
          created_at?: string
          doi?: string | null
          id?: string
          kind?: string
          title?: string
          updated_at?: string
          url?: string | null
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "device_category_references_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "device_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "device_category_references_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "project_device_usage"
            referencedColumns: ["category_key"]
          },
        ]
      }
      device_class_crosswalk: {
        Row: {
          category_key: string
          created_at: string
          id: string
          legacy_key: string
          updated_at: string
        }
        Insert: {
          category_key: string
          created_at?: string
          id?: string
          legacy_key: string
          updated_at?: string
        }
        Update: {
          category_key?: string
          created_at?: string
          id?: string
          legacy_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_class_crosswalk_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "device_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "device_class_crosswalk_category_key_fkey"
            columns: ["category_key"]
            isOneToOne: false
            referencedRelation: "project_device_usage"
            referencedColumns: ["category_key"]
          },
        ]
      }
      device_manufacturers: {
        Row: {
          aliases: string[]
          country: string | null
          created_at: string
          homepage_url: string | null
          id: string
          last_crawled_at: string | null
          name: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          aliases?: string[]
          country?: string | null
          created_at?: string
          homepage_url?: string | null
          id?: string
          last_crawled_at?: string | null
          name: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          aliases?: string[]
          country?: string | null
          created_at?: string
          homepage_url?: string | null
          id?: string
          last_crawled_at?: string | null
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      device_models: {
        Row: {
          aliases: string[]
          confidence: number | null
          created_at: string
          device_class: string
          firmware_notes: string | null
          first_seen_at: string
          id: string
          last_verified_at: string | null
          manual_urls: string[]
          manufacturer_id: string | null
          model_name: string
          output_signals: string[]
          price_tier: string | null
          product_url: string | null
          regulatory: string | null
          regulatory_class: string | null
          sampling_rate_hz: number | null
          sdk_urls: string[]
          updated_at: string
        }
        Insert: {
          aliases?: string[]
          confidence?: number | null
          created_at?: string
          device_class: string
          firmware_notes?: string | null
          first_seen_at?: string
          id?: string
          last_verified_at?: string | null
          manual_urls?: string[]
          manufacturer_id?: string | null
          model_name: string
          output_signals?: string[]
          price_tier?: string | null
          product_url?: string | null
          regulatory?: string | null
          regulatory_class?: string | null
          sampling_rate_hz?: number | null
          sdk_urls?: string[]
          updated_at?: string
        }
        Update: {
          aliases?: string[]
          confidence?: number | null
          created_at?: string
          device_class?: string
          firmware_notes?: string | null
          first_seen_at?: string
          id?: string
          last_verified_at?: string | null
          manual_urls?: string[]
          manufacturer_id?: string | null
          model_name?: string
          output_signals?: string[]
          price_tier?: string | null
          product_url?: string | null
          regulatory?: string | null
          regulatory_class?: string | null
          sampling_rate_hz?: number | null
          sdk_urls?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_models_manufacturer_id_fkey"
            columns: ["manufacturer_id"]
            isOneToOne: false
            referencedRelation: "device_manufacturers"
            referencedColumns: ["id"]
          },
        ]
      }
      edit_history: {
        Row: {
          chat_context: Json | null
          created_at: string
          edited_by: string
          field_name: string
          grant_number: string
          id: string
          new_value: Json | null
          old_value: Json | null
          project_id: string | null
          validation_checks: Json | null
          validation_status: string | null
        }
        Insert: {
          chat_context?: Json | null
          created_at?: string
          edited_by?: string
          field_name: string
          grant_number: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          project_id?: string | null
          validation_checks?: Json | null
          validation_status?: string | null
        }
        Update: {
          chat_context?: Json | null
          created_at?: string
          edited_by?: string
          field_name?: string
          grant_number?: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          project_id?: string | null
          validation_checks?: Json | null
          validation_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "edit_history_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_device_usage"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "edit_history_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_comments: {
        Row: {
          content: string
          created_at: string
          id: string
          parent_id: string | null
          resource_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          parent_id?: string | null
          resource_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          parent_id?: string | null
          resource_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "entity_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_comments_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_suggestions: {
        Row: {
          created_at: string
          description: string | null
          github_issue_number: number | null
          github_issue_url: string | null
          id: string
          organization_id: string | null
          status: string
          submitted_by: string | null
          submitter_name: string | null
          title: string
          updated_at: string
          votes: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: string
          organization_id?: string | null
          status?: string
          submitted_by?: string | null
          submitter_name?: string | null
          title: string
          updated_at?: string
          votes?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: string
          organization_id?: string | null
          status?: string
          submitted_by?: string | null
          submitter_name?: string | null
          title?: string
          updated_at?: string
          votes?: number
        }
        Relationships: [
          {
            foreignKeyName: "feature_suggestions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_votes: {
        Row: {
          created_at: string
          suggestion_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          suggestion_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          suggestion_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feature_votes_suggestion_id_fkey"
            columns: ["suggestion_id"]
            isOneToOne: false
            referencedRelation: "feature_suggestions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_votes_suggestion_id_fkey"
            columns: ["suggestion_id"]
            isOneToOne: false
            referencedRelation: "feature_suggestions_public"
            referencedColumns: ["id"]
          },
        ]
      }
      funding_opportunities: {
        Row: {
          activity_code: string | null
          announcement_type: string | null
          budget_ceiling: number | null
          budget_floor: number | null
          created_at: string
          due_dates: Json | null
          eligible_activity_codes: string[] | null
          expiration_date: string | null
          fon: string
          id: string
          notes: string | null
          open_date: string | null
          participating_orgs: string[] | null
          posted_date: string | null
          purpose: string | null
          relevance_tags: string[] | null
          status: string
          title: string
          updated_at: string
          url: string | null
        }
        Insert: {
          activity_code?: string | null
          announcement_type?: string | null
          budget_ceiling?: number | null
          budget_floor?: number | null
          created_at?: string
          due_dates?: Json | null
          eligible_activity_codes?: string[] | null
          expiration_date?: string | null
          fon: string
          id?: string
          notes?: string | null
          open_date?: string | null
          participating_orgs?: string[] | null
          posted_date?: string | null
          purpose?: string | null
          relevance_tags?: string[] | null
          status?: string
          title: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          activity_code?: string | null
          announcement_type?: string | null
          budget_ceiling?: number | null
          budget_floor?: number | null
          created_at?: string
          due_dates?: Json | null
          eligible_activity_codes?: string[] | null
          expiration_date?: string | null
          fon?: string
          id?: string
          notes?: string | null
          open_date?: string | null
          participating_orgs?: string[] | null
          posted_date?: string | null
          purpose?: string | null
          relevance_tags?: string[] | null
          status?: string
          title?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: []
      }
      grant_dandisets: {
        Row: {
          created_at: string
          dandiset_id: string
          grant_id: string
          match_source: string
          matched_award: string | null
        }
        Insert: {
          created_at?: string
          dandiset_id: string
          grant_id: string
          match_source?: string
          matched_award?: string | null
        }
        Update: {
          created_at?: string
          dandiset_id?: string
          grant_id?: string
          match_source?: string
          matched_award?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grant_dandisets_dandiset_id_fkey"
            columns: ["dandiset_id"]
            isOneToOne: false
            referencedRelation: "dandisets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_dandisets_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "grants"
            referencedColumns: ["id"]
          },
        ]
      }
      grant_investigators: {
        Row: {
          created_at: string
          grant_id: string | null
          investigator_id: string
          role: string
          role_source: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          grant_id?: string | null
          investigator_id: string
          role?: string
          role_source?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          grant_id?: string | null
          investigator_id?: string
          role?: string
          role_source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "grant_investigators_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_investigators_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "investigator_directory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_investigators_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "investigators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_investigators_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "investigators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_investigators_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "onboarding_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      grant_methods_evidence: {
        Row: {
          analysis_metrics: Json | null
          behavior_paradigm: string[] | null
          confidence: number | null
          created_at: string
          depth: number
          device_class: string[] | null
          device_hardware: Json | null
          device_model: string[]
          discovery_path_id: string | null
          environment_tags: string[]
          extracted_at: string
          id: string
          irb_or_population: string | null
          manual_urls: string[]
          manufacturer: string[]
          match_score: number | null
          methods_snippet: string | null
          modality: string[]
          pmid: string | null
          publication_title: string | null
          publication_year: number | null
          quote: string | null
          recording_params: Json | null
          regulatory: string | null
          seed_grant_number: string
          setting: string | null
          source_grant_number: string
          source_grant_title: string | null
          source_org: string | null
          source_org_type: string | null
          source_url: string | null
          species: string[] | null
          stimulation_params: Json | null
          study_arm: string | null
          subject_n: number | null
          updated_at: string
          use_case: string | null
        }
        Insert: {
          analysis_metrics?: Json | null
          behavior_paradigm?: string[] | null
          confidence?: number | null
          created_at?: string
          depth?: number
          device_class?: string[] | null
          device_hardware?: Json | null
          device_model?: string[]
          discovery_path_id?: string | null
          environment_tags?: string[]
          extracted_at?: string
          id?: string
          irb_or_population?: string | null
          manual_urls?: string[]
          manufacturer?: string[]
          match_score?: number | null
          methods_snippet?: string | null
          modality?: string[]
          pmid?: string | null
          publication_title?: string | null
          publication_year?: number | null
          quote?: string | null
          recording_params?: Json | null
          regulatory?: string | null
          seed_grant_number: string
          setting?: string | null
          source_grant_number: string
          source_grant_title?: string | null
          source_org?: string | null
          source_org_type?: string | null
          source_url?: string | null
          species?: string[] | null
          stimulation_params?: Json | null
          study_arm?: string | null
          subject_n?: number | null
          updated_at?: string
          use_case?: string | null
        }
        Update: {
          analysis_metrics?: Json | null
          behavior_paradigm?: string[] | null
          confidence?: number | null
          created_at?: string
          depth?: number
          device_class?: string[] | null
          device_hardware?: Json | null
          device_model?: string[]
          discovery_path_id?: string | null
          environment_tags?: string[]
          extracted_at?: string
          id?: string
          irb_or_population?: string | null
          manual_urls?: string[]
          manufacturer?: string[]
          match_score?: number | null
          methods_snippet?: string | null
          modality?: string[]
          pmid?: string | null
          publication_title?: string | null
          publication_year?: number | null
          quote?: string | null
          recording_params?: Json | null
          regulatory?: string | null
          seed_grant_number?: string
          setting?: string | null
          source_grant_number?: string
          source_grant_title?: string | null
          source_org?: string | null
          source_org_type?: string | null
          source_url?: string | null
          species?: string[] | null
          stimulation_params?: Json | null
          study_arm?: string | null
          subject_n?: number | null
          updated_at?: string
          use_case?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grant_methods_evidence_discovery_path_id_fkey"
            columns: ["discovery_path_id"]
            isOneToOne: false
            referencedRelation: "grant_methods_traversal_paths"
            referencedColumns: ["id"]
          },
        ]
      }
      grant_methods_traversal_paths: {
        Row: {
          chain_score: number
          created_at: string
          id: string
          path: Json
          planner_model: string | null
          replan_count: number
          seed_grant_number: string
          terminal_evidence_id: string | null
          updated_at: string
        }
        Insert: {
          chain_score?: number
          created_at?: string
          id?: string
          path: Json
          planner_model?: string | null
          replan_count?: number
          seed_grant_number: string
          terminal_evidence_id?: string | null
          updated_at?: string
        }
        Update: {
          chain_score?: number
          created_at?: string
          id?: string
          path?: Json
          planner_model?: string | null
          replan_count?: number
          seed_grant_number?: string
          terminal_evidence_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "grant_methods_traversal_paths_terminal_evidence_id_fkey"
            columns: ["terminal_evidence_id"]
            isOneToOne: false
            referencedRelation: "grant_methods_evidence"
            referencedColumns: ["id"]
          },
        ]
      }
      grants: {
        Row: {
          abstract: string | null
          award_amount: number | null
          created_at: string
          fiscal_year: number | null
          grant_number: string
          id: string
          nih_link: string | null
          reporter_project_num: string | null
          resource_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          abstract?: string | null
          award_amount?: number | null
          created_at?: string
          fiscal_year?: number | null
          grant_number: string
          id?: string
          nih_link?: string | null
          reporter_project_num?: string | null
          resource_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          abstract?: string | null
          award_amount?: number | null
          created_at?: string
          fiscal_year?: number | null
          grant_number?: string
          id?: string
          nih_link?: string | null
          reporter_project_num?: string | null
          resource_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "grants_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      group_audit_dismissals: {
        Row: {
          dismissed_at: string
          dismissed_by: string | null
          group_email: string
          member_email: string
          reason: string | null
          role_at_dismissal: string | null
        }
        Insert: {
          dismissed_at?: string
          dismissed_by?: string | null
          group_email: string
          member_email: string
          reason?: string | null
          role_at_dismissal?: string | null
        }
        Update: {
          dismissed_at?: string
          dismissed_by?: string | null
          group_email?: string
          member_email?: string
          reason?: string | null
          role_at_dismissal?: string | null
        }
        Relationships: []
      }
      harvester_keywords: {
        Row: {
          canonical_term: string | null
          created_at: string
          first_seen_at: string
          frequency: number
          id: string
          kind: string
          last_seen_at: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          term: string
          updated_at: string
        }
        Insert: {
          canonical_term?: string | null
          created_at?: string
          first_seen_at?: string
          frequency?: number
          id?: string
          kind: string
          last_seen_at?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          term: string
          updated_at?: string
        }
        Update: {
          canonical_term?: string | null
          created_at?: string
          first_seen_at?: string
          frequency?: number
          id?: string
          kind?: string
          last_seen_at?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          term?: string
          updated_at?: string
        }
        Relationships: []
      }
      harvester_queue: {
        Row: {
          cool_down_hours: number
          created_at: string
          enabled: boolean
          id: string
          last_run_at: string | null
          last_run_id: string | null
          notes: string | null
          priority: number
          seed_grant: string
          updated_at: string
        }
        Insert: {
          cool_down_hours?: number
          created_at?: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          last_run_id?: string | null
          notes?: string | null
          priority?: number
          seed_grant: string
          updated_at?: string
        }
        Update: {
          cool_down_hours?: number
          created_at?: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          last_run_id?: string | null
          notes?: string | null
          priority?: number
          seed_grant?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "harvester_queue_last_run_id_fkey"
            columns: ["last_run_id"]
            isOneToOne: false
            referencedRelation: "harvester_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      harvester_relations: {
        Row: {
          approved_at: string
          approved_by: string | null
          created_at: string
          description: string | null
          dst_node_type: string
          enabled: boolean
          fetcher_key: string
          id: string
          name: string
          src_node_type: string
        }
        Insert: {
          approved_at?: string
          approved_by?: string | null
          created_at?: string
          description?: string | null
          dst_node_type: string
          enabled?: boolean
          fetcher_key: string
          id?: string
          name: string
          src_node_type: string
        }
        Update: {
          approved_at?: string
          approved_by?: string | null
          created_at?: string
          description?: string | null
          dst_node_type?: string
          enabled?: boolean
          fetcher_key?: string
          id?: string
          name?: string
          src_node_type?: string
        }
        Relationships: []
      }
      harvester_runs: {
        Row: {
          created_at: string
          current_hop: number
          current_target: string | null
          errors: number
          evidence_rows: number
          finished_at: string | null
          firecrawl_calls: number
          hop_similarities: Json | null
          hops_taken: number | null
          id: string
          last_message: string | null
          max_hops_configured: number | null
          phase: string
          pubs_found: number
          retry_after: string | null
          seed_grant: string
          similar_projects_visited: number | null
          started_at: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_hop?: number
          current_target?: string | null
          errors?: number
          evidence_rows?: number
          finished_at?: string | null
          firecrawl_calls?: number
          hop_similarities?: Json | null
          hops_taken?: number | null
          id?: string
          last_message?: string | null
          max_hops_configured?: number | null
          phase?: string
          pubs_found?: number
          retry_after?: string | null
          seed_grant: string
          similar_projects_visited?: number | null
          started_at?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_hop?: number
          current_target?: string | null
          errors?: number
          evidence_rows?: number
          finished_at?: string | null
          firecrawl_calls?: number
          hop_similarities?: Json | null
          hops_taken?: number | null
          id?: string
          last_message?: string | null
          max_hops_configured?: number | null
          phase?: string
          pubs_found?: number
          retry_after?: string | null
          seed_grant?: string
          similar_projects_visited?: number | null
          started_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      harvester_settings: {
        Row: {
          batch_paused: boolean
          beam_width: number
          chain_score_threshold: number
          created_at: string
          id: number
          max_hops: number
          max_publications_per_seed: number
          max_replans: number
          targets_per_relation: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          batch_paused?: boolean
          beam_width?: number
          chain_score_threshold?: number
          created_at?: string
          id?: number
          max_hops?: number
          max_publications_per_seed?: number
          max_replans?: number
          targets_per_relation?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          batch_paused?: boolean
          beam_width?: number
          chain_score_threshold?: number
          created_at?: string
          id?: number
          max_hops?: number
          max_publications_per_seed?: number
          max_replans?: number
          targets_per_relation?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      harvester_synonyms: {
        Row: {
          alias: string
          canonical: string
          created_at: string
          created_by: string | null
          id: string
          kind: string
        }
        Insert: {
          alias: string
          canonical: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
        }
        Update: {
          alias?: string
          canonical?: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
        }
        Relationships: []
      }
      investigator_organizations: {
        Row: {
          created_at: string
          investigator_id: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          investigator_id: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          investigator_id?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "investigator_organizations_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "investigator_directory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "investigator_organizations_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "investigators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "investigator_organizations_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "investigators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "investigator_organizations_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "onboarding_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "investigator_organizations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      investigators: {
        Row: {
          created_at: string
          email: string | null
          id: string
          institution: string | null
          last_reminder_sent_at: string | null
          name: string
          onboarding_checklist: Json | null
          onboarding_completed_at: string | null
          orcid: string | null
          pending_role: Database["public"]["Enums"]["app_role"] | null
          profile_url: string | null
          reminder_count: number
          requested_working_groups: string[] | null
          research_areas: string[] | null
          resource_id: string | null
          role: string | null
          scholar_id: string | null
          secondary_emails: string[] | null
          skills: string[] | null
          updated_at: string
          user_id: string | null
          working_groups: string[] | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          institution?: string | null
          last_reminder_sent_at?: string | null
          name: string
          onboarding_checklist?: Json | null
          onboarding_completed_at?: string | null
          orcid?: string | null
          pending_role?: Database["public"]["Enums"]["app_role"] | null
          profile_url?: string | null
          reminder_count?: number
          requested_working_groups?: string[] | null
          research_areas?: string[] | null
          resource_id?: string | null
          role?: string | null
          scholar_id?: string | null
          secondary_emails?: string[] | null
          skills?: string[] | null
          updated_at?: string
          user_id?: string | null
          working_groups?: string[] | null
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          institution?: string | null
          last_reminder_sent_at?: string | null
          name?: string
          onboarding_checklist?: Json | null
          onboarding_completed_at?: string | null
          orcid?: string | null
          pending_role?: Database["public"]["Enums"]["app_role"] | null
          profile_url?: string | null
          reminder_count?: number
          requested_working_groups?: string[] | null
          research_areas?: string[] | null
          resource_id?: string | null
          role?: string | null
          scholar_id?: string | null
          secondary_emails?: string[] | null
          skills?: string[] | null
          updated_at?: string
          user_id?: string | null
          working_groups?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "investigators_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          application_url: string | null
          contact_email: string | null
          contact_name: string | null
          created_at: string
          department: string | null
          description: string | null
          expires_at: string | null
          id: string
          institution: string
          is_active: boolean
          job_type: string
          location: string | null
          organization_id: string | null
          posted_by: string | null
          resource_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          application_url?: string | null
          contact_email?: string | null
          contact_name?: string | null
          created_at?: string
          department?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string
          institution: string
          is_active?: boolean
          job_type?: string
          location?: string | null
          organization_id?: string | null
          posted_by?: string | null
          resource_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          application_url?: string | null
          contact_email?: string | null
          contact_name?: string | null
          created_at?: string
          department?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string
          institution?: string
          is_active?: boolean
          job_type?: string
          location?: string | null
          organization_id?: string | null
          posted_by?: string | null
          resource_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_embeddings: {
        Row: {
          content: string
          created_at: string
          embedding: string | null
          id: string
          metadata: Json | null
          resource_id: string | null
          source_id: string
          source_type: string
          title: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          resource_id?: string | null
          source_id: string
          source_type: string
          title: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          resource_id?: string | null
          source_id?: string
          source_type?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_embeddings_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      lovable_credit_events: {
        Row: {
          created_at: string
          created_by: string | null
          credits: number
          event_type: string
          id: string
          notes: string | null
          occurred_at: string
          usd_amount: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          credits?: number
          event_type: string
          id?: string
          notes?: string | null
          occurred_at?: string
          usd_amount?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          credits?: number
          event_type?: string
          id?: string
          notes?: string | null
          occurred_at?: string
          usd_amount?: number
        }
        Relationships: []
      }
      lovable_invoices: {
        Row: {
          amount_usd: number
          created_at: string
          description: string
          external_invoice_id: string | null
          id: string
          invoice_date: string
          notes: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount_usd: number
          created_at?: string
          description: string
          external_invoice_id?: string | null
          id?: string
          invoice_date: string
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount_usd?: number
          created_at?: string
          description?: string
          external_invoice_id?: string | null
          id?: string
          invoice_date?: string
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      lovable_user_usage: {
        Row: {
          created_at: string
          created_by: string | null
          credits_used: number
          id: string
          notes: string | null
          period_month: string
          updated_at: string
          usd_equivalent: number
          user_id: string | null
          user_label: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          credits_used?: number
          id?: string
          notes?: string | null
          period_month: string
          updated_at?: string
          usd_equivalent?: number
          user_id?: string | null
          user_label?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          credits_used?: number
          id?: string
          notes?: string | null
          period_month?: string
          updated_at?: string
          usd_equivalent?: number
          user_id?: string | null
          user_label?: string | null
        }
        Relationships: []
      }
      news_candidates: {
        Row: {
          announcement_id: string | null
          author: string | null
          created_at: string
          id: string
          matched_keywords: string[]
          published_at: string | null
          raw: Json | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          score: number
          source: string
          source_url: string | null
          status: string
          summary: string | null
          title: string
          updated_at: string
          url: string
        }
        Insert: {
          announcement_id?: string | null
          author?: string | null
          created_at?: string
          id?: string
          matched_keywords?: string[]
          published_at?: string | null
          raw?: Json | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          score?: number
          source: string
          source_url?: string | null
          status?: string
          summary?: string | null
          title: string
          updated_at?: string
          url: string
        }
        Update: {
          announcement_id?: string | null
          author?: string | null
          created_at?: string
          id?: string
          matched_keywords?: string[]
          published_at?: string | null
          raw?: Json | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          score?: number
          source?: string
          source_url?: string | null
          status?: string
          summary?: string | null
          title?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "news_candidates_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          resource_id: string | null
          url: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          resource_id?: string | null
          url?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          resource_id?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organizations_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      personality_scores: {
        Row: {
          big_five: Json
          created_at: string
          hexaco: Json
          investigator_id: string
          last_computed_at: string
          matched_count: number
          token_count: number
          top_adjectives: Json
          updated_at: string
        }
        Insert: {
          big_five?: Json
          created_at?: string
          hexaco?: Json
          investigator_id: string
          last_computed_at?: string
          matched_count?: number
          token_count?: number
          top_adjectives?: Json
          updated_at?: string
        }
        Update: {
          big_five?: Json
          created_at?: string
          hexaco?: Json
          investigator_id?: string
          last_computed_at?: string
          matched_count?: number
          token_count?: number
          top_adjectives?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "personality_scores_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: true
            referencedRelation: "investigator_directory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personality_scores_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: true
            referencedRelation: "investigators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personality_scores_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: true
            referencedRelation: "investigators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personality_scores_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: true
            referencedRelation: "onboarding_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          organization_id: string | null
          theme_preference: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          organization_id?: string | null
          theme_preference?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          organization_id?: string | null
          theme_preference?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      project_publications: {
        Row: {
          created_at: string
          project_id: string
          publication_id: string
        }
        Insert: {
          created_at?: string
          project_id: string
          publication_id: string
        }
        Update: {
          created_at?: string
          project_id?: string
          publication_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_publications_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_device_usage"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "project_publications_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_publications_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "publications"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          created_at: string
          grant_id: string | null
          grant_number: string
          id: string
          keywords: string[] | null
          last_edited_by: string | null
          metadata: Json | null
          metadata_completeness: number | null
          onboarding_status: string | null
          organization_id: string | null
          resource_id: string | null
          study_human: boolean | null
          study_species: string[] | null
          updated_at: string
          website: string | null
        }
        Insert: {
          created_at?: string
          grant_id?: string | null
          grant_number: string
          id?: string
          keywords?: string[] | null
          last_edited_by?: string | null
          metadata?: Json | null
          metadata_completeness?: number | null
          onboarding_status?: string | null
          organization_id?: string | null
          resource_id?: string | null
          study_human?: boolean | null
          study_species?: string[] | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          created_at?: string
          grant_id?: string | null
          grant_number?: string
          id?: string
          keywords?: string[] | null
          last_edited_by?: string | null
          metadata?: Json | null
          metadata_completeness?: number | null
          onboarding_status?: string | null
          organization_id?: string | null
          resource_id?: string | null
          study_human?: boolean | null
          study_species?: string[] | null
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_metadata_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      proposed_relations: {
        Row: {
          created_at: string
          dst_node_type: string | null
          example_edge: Json | null
          id: string
          planner_rationale: string | null
          relation_name: string
          reviewed_at: string | null
          reviewed_by: string | null
          seed_grant_number: string | null
          src_node_type: string | null
          status: string
        }
        Insert: {
          created_at?: string
          dst_node_type?: string | null
          example_edge?: Json | null
          id?: string
          planner_rationale?: string | null
          relation_name: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          seed_grant_number?: string | null
          src_node_type?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          dst_node_type?: string | null
          example_edge?: Json | null
          id?: string
          planner_rationale?: string | null
          relation_name?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          seed_grant_number?: string | null
          src_node_type?: string | null
          status?: string
        }
        Relationships: []
      }
      publications: {
        Row: {
          author_orcids: Json | null
          authors: string | null
          citations: number | null
          created_at: string
          doi: string | null
          id: string
          journal: string | null
          keywords: string[] | null
          pmid: string | null
          pubmed_link: string | null
          rcr: number | null
          resource_id: string | null
          title: string
          updated_at: string
          year: number | null
        }
        Insert: {
          author_orcids?: Json | null
          authors?: string | null
          citations?: number | null
          created_at?: string
          doi?: string | null
          id?: string
          journal?: string | null
          keywords?: string[] | null
          pmid?: string | null
          pubmed_link?: string | null
          rcr?: number | null
          resource_id?: string | null
          title: string
          updated_at?: string
          year?: number | null
        }
        Update: {
          author_orcids?: Json | null
          authors?: string | null
          citations?: number | null
          created_at?: string
          doi?: string | null
          id?: string
          journal?: string | null
          keywords?: string[] | null
          pmid?: string | null
          pubmed_link?: string | null
          rcr?: number | null
          resource_id?: string | null
          title?: string
          updated_at?: string
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "publications_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      resources: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          external_url: string | null
          id: string
          metadata: Json | null
          name: string
          organization_id: string | null
          resource_type: Database["public"]["Enums"]["resource_type"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          external_url?: string | null
          id?: string
          metadata?: Json | null
          name: string
          organization_id?: string | null
          resource_type: Database["public"]["Enums"]["resource_type"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          external_url?: string | null
          id?: string
          metadata?: Json | null
          name?: string
          organization_id?: string | null
          resource_type?: Database["public"]["Enums"]["resource_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "resources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      search_queries: {
        Row: {
          created_at: string
          id: string
          mode: string
          query: string
          results_count: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          mode?: string
          query: string
          results_count?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          mode?: string
          query?: string
          results_count?: number | null
        }
        Relationships: []
      }
      security_audit_results: {
        Row: {
          created_at: string
          drift_detected: boolean
          findings: Json
          findings_count: number
          id: string
          notified: boolean
          policy_snapshot: Json
          scan_type: string
          tables_scanned: number
        }
        Insert: {
          created_at?: string
          drift_detected?: boolean
          findings?: Json
          findings_count?: number
          id?: string
          notified?: boolean
          policy_snapshot?: Json
          scan_type?: string
          tables_scanned?: number
        }
        Update: {
          created_at?: string
          drift_detected?: boolean
          findings?: Json
          findings_count?: number
          id?: string
          notified?: boolean
          policy_snapshot?: Json
          scan_type?: string
          tables_scanned?: number
        }
        Relationships: []
      }
      software_tools: {
        Row: {
          created_at: string
          description: string | null
          docs_url: string | null
          id: string
          language: string | null
          license: string | null
          name: string
          repo_url: string | null
          resource_id: string | null
          updated_at: string
          version: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          docs_url?: string | null
          id?: string
          language?: string | null
          license?: string | null
          name: string
          repo_url?: string | null
          resource_id?: string | null
          updated_at?: string
          version?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          docs_url?: string | null
          id?: string
          language?: string | null
          license?: string | null
          name?: string
          repo_url?: string | null
          resource_id?: string | null
          updated_at?: string
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "software_tools_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      species: {
        Row: {
          common_name: string | null
          created_at: string
          id: string
          metadata: Json | null
          name: string
          resource_id: string | null
          taxonomy_class: string | null
          taxonomy_family: string | null
          taxonomy_genus: string | null
          taxonomy_order: string | null
          updated_at: string
        }
        Insert: {
          common_name?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          name: string
          resource_id?: string | null
          taxonomy_class?: string | null
          taxonomy_family?: string | null
          taxonomy_genus?: string | null
          taxonomy_order?: string | null
          updated_at?: string
        }
        Update: {
          common_name?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          name?: string
          resource_id?: string | null
          taxonomy_class?: string | null
          taxonomy_family?: string | null
          taxonomy_genus?: string | null
          taxonomy_order?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "species_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      state_privacy_rules: {
        Row: {
          categories: Json
          created_at: string
          id: string
          last_reviewed: string
          scan_status: string
          sources: Json | null
          state: string
          state_name: string
          updated_at: string
        }
        Insert: {
          categories?: Json
          created_at?: string
          id?: string
          last_reviewed?: string
          scan_status?: string
          sources?: Json | null
          state: string
          state_name: string
          updated_at?: string
        }
        Update: {
          categories?: Json
          created_at?: string
          id?: string
          last_reviewed?: string
          scan_status?: string
          sources?: Json | null
          state?: string
          state_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      system_alerts: {
        Row: {
          created_at: string
          details: Json | null
          email_sent: boolean
          email_sent_at: string | null
          error_code: string
          fingerprint: string
          first_seen_at: string
          github_issue_number: number | null
          github_issue_url: string | null
          id: string
          last_seen_at: string
          message: string
          occurrence_count: number
          resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          source: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          details?: Json | null
          email_sent?: boolean
          email_sent_at?: string | null
          error_code: string
          fingerprint: string
          first_seen_at?: string
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: string
          last_seen_at?: string
          message: string
          occurrence_count?: number
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          source: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          details?: Json | null
          email_sent?: boolean
          email_sent_at?: string | null
          error_code?: string
          fingerprint?: string
          first_seen_at?: string
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: string
          last_seen_at?: string
          message?: string
          occurrence_count?: number
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_dashboard_layouts: {
        Row: {
          created_at: string
          onboarded_at: string | null
          updated_at: string
          user_id: string
          widgets: Json
          working_groups: string[]
        }
        Insert: {
          created_at?: string
          onboarded_at?: string | null
          updated_at?: string
          user_id: string
          widgets?: Json
          working_groups?: string[]
        }
        Update: {
          created_at?: string
          onboarded_at?: string | null
          updated_at?: string
          user_id?: string
          widgets?: Json
          working_groups?: string[]
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          granted_by: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      working_group_dashboard_defaults: {
        Row: {
          created_at: string
          id: string
          updated_at: string
          widgets: Json
          working_group: string
        }
        Insert: {
          created_at?: string
          id?: string
          updated_at?: string
          widgets?: Json
          working_group: string
        }
        Update: {
          created_at?: string
          id?: string
          updated_at?: string
          widgets?: Json
          working_group?: string
        }
        Relationships: []
      }
    }
    Views: {
      feature_suggestions_public: {
        Row: {
          created_at: string | null
          description: string | null
          github_issue_number: number | null
          github_issue_url: string | null
          id: string | null
          status: string | null
          title: string | null
          updated_at: string | null
          votes: number | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          votes?: number | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          votes?: number | null
        }
        Relationships: []
      }
      group_audit_dismissals_live: {
        Row: {
          current_role: string | null
          dismissed_at: string | null
          group_email: string | null
          member_email: string | null
          member_name: string | null
          reason: string | null
          role_at_dismissal: string | null
          role_changed: boolean | null
        }
        Relationships: []
      }
      investigator_cohorts: {
        Row: {
          cohort: string | null
          investigator_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grant_investigators_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "investigator_directory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_investigators_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "investigators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_investigators_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "investigators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_investigators_investigator_id_fkey"
            columns: ["investigator_id"]
            isOneToOne: false
            referencedRelation: "onboarding_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      investigator_directory: {
        Row: {
          created_at: string | null
          email: string | null
          id: string | null
          institution: string | null
          name: string | null
          onboarding_checklist: Json | null
          onboarding_completed_at: string | null
          orcid: string | null
          profile_url: string | null
          research_areas: string[] | null
          resource_id: string | null
          role: string | null
          scholar_id: string | null
          skills: string[] | null
          updated_at: string | null
          user_id: string | null
          working_groups: string[] | null
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          id?: string | null
          institution?: string | null
          name?: string | null
          onboarding_checklist?: Json | null
          onboarding_completed_at?: string | null
          orcid?: string | null
          profile_url?: string | null
          research_areas?: string[] | null
          resource_id?: string | null
          role?: string | null
          scholar_id?: string | null
          skills?: string[] | null
          updated_at?: string | null
          user_id?: string | null
          working_groups?: string[] | null
        }
        Update: {
          created_at?: string | null
          email?: string | null
          id?: string | null
          institution?: string | null
          name?: string | null
          onboarding_checklist?: Json | null
          onboarding_completed_at?: string | null
          orcid?: string | null
          profile_url?: string | null
          research_areas?: string[] | null
          resource_id?: string | null
          role?: string | null
          scholar_id?: string | null
          skills?: string[] | null
          updated_at?: string | null
          user_id?: string | null
          working_groups?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "investigators_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      investigators_public: {
        Row: {
          created_at: string | null
          id: string | null
          name: string | null
          orcid: string | null
          pending_role: Database["public"]["Enums"]["app_role"] | null
          profile_url: string | null
          research_areas: string[] | null
          resource_id: string | null
          role: string | null
          scholar_id: string | null
          skills: string[] | null
          updated_at: string | null
          user_id: string | null
          working_groups: string[] | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          name?: string | null
          orcid?: string | null
          pending_role?: Database["public"]["Enums"]["app_role"] | null
          profile_url?: string | null
          research_areas?: string[] | null
          resource_id?: string | null
          role?: string | null
          scholar_id?: string | null
          skills?: string[] | null
          updated_at?: string | null
          user_id?: string | null
          working_groups?: string[] | null
        }
        Update: {
          created_at?: string | null
          id?: string | null
          name?: string | null
          orcid?: string | null
          pending_role?: Database["public"]["Enums"]["app_role"] | null
          profile_url?: string | null
          research_areas?: string[] | null
          resource_id?: string | null
          role?: string | null
          scholar_id?: string | null
          skills?: string[] | null
          updated_at?: string | null
          user_id?: string | null
          working_groups?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "investigators_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_pipeline: {
        Row: {
          checklist: Json | null
          created_at: string | null
          days_since_created: number | null
          email: string | null
          id: string | null
          is_stuck: boolean | null
          last_reminder_sent_at: string | null
          live_grant_count: number | null
          name: string | null
          reminder_count: number | null
          role: string | null
          steps_done: number | null
          steps_total: number | null
          working_groups: string[] | null
        }
        Relationships: []
      }
      project_device_usage: {
        Row: {
          catalog_models: number | null
          category_key: string | null
          category_label: string | null
          evidence_count: number | null
          evidence_terms: string[] | null
          grant_number: string | null
          grant_title: string | null
          measures: string[] | null
          project_id: string | null
        }
        Relationships: []
      }
      project_devices_v: {
        Row: {
          confidence_max: number | null
          device_class: string | null
          device_label: string | null
          environment_tags: string[] | null
          evidence_count: number | null
          grant_number: string | null
          hardware_label: string | null
          latest_evidence_at: string | null
          manual_urls: string[] | null
          manufacturer: string | null
          match_score_max: number | null
          min_depth: number | null
          model_name: string | null
          quote: string | null
          sample_pmid: string | null
          sample_title: string | null
          sample_use_case: string | null
          setting: string | null
          source_grant_title: string | null
          source_org: string | null
          source_url: string | null
          species: string[] | null
        }
        Relationships: []
      }
      public_jobs: {
        Row: {
          application_url: string | null
          created_at: string | null
          department: string | null
          description: string | null
          expires_at: string | null
          id: string | null
          institution: string | null
          is_active: boolean | null
          job_type: string | null
          location: string | null
          organization_id: string | null
          resource_id: string | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          application_url?: string | null
          created_at?: string | null
          department?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string | null
          institution?: string | null
          is_active?: boolean | null
          job_type?: string | null
          location?: string | null
          organization_id?: string | null
          resource_id?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          application_url?: string | null
          created_at?: string | null
          department?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string | null
          institution?: string | null
          is_active?: boolean | null
          job_type?: string | null
          location?: string | null
          organization_id?: string | null
          resource_id?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      admin_get_last_logins: {
        Args: never
        Returns: {
          last_sign_in_at: string
          user_id: string
        }[]
      }
      approve_working_groups: {
        Args: { _groups?: string[]; _investigator_id: string }
        Returns: Json
      }
      canonical_working_group: { Args: { _wg: string }; Returns: string }
      cron_invoke: {
        Args: {
          _body?: Json
          _function: string
          _query?: string
          _timeout_ms?: number
        }
        Returns: number
      }
      current_actor_via: { Args: never; Returns: string }
      decrement_vote_count: {
        Args: { _suggestion_id: string }
        Returns: undefined
      }
      dismiss_group_audit_entry: {
        Args: { _group_email: string; _member_email: string; _reason?: string }
        Returns: Json
      }
      email_is_consortium_member: { Args: { _email: string }; Returns: boolean }
      get_investigator_attention: {
        Args: never
        Returns: {
          clicks: number
          investigator_id: string
          pageviews: number
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      increment_vote_count: {
        Args: { _suggestion_id: string }
        Returns: undefined
      }
      ir_drain_queue: {
        Args: { _limit?: number }
        Returns: {
          investigator_id: string
        }[]
      }
      ir_is_authorized: { Args: never; Returns: boolean }
      ir_upsert_profiles: { Args: { _rows: Json }; Returns: number }
      is_curator_or_admin: { Args: { _user_id: string }; Returns: boolean }
      kg_read_sql: { Args: { max_rows?: number; query: string }; Returns: Json }
      link_investigator_grant: {
        Args: { _grant_id: string; _investigator_id: string; _role?: string }
        Returns: Json
      }
      member_self_update: {
        Args: {
          _institution?: string
          _orcid?: string
          _requested_working_groups?: string[]
          _research_areas?: string[]
          _secondary_emails?: string[]
          _skills?: string[]
        }
        Returns: Json
      }
      offboard_member: {
        Args: { _grant_id?: string; _investigator_id: string }
        Returns: Json
      }
      onboard_member: {
        Args: {
          _email: string
          _grant_id?: string
          _institution?: string
          _name: string
          _pending_role?: string
          _role?: string
          _secondary_emails?: string[]
          _working_groups?: string[]
        }
        Returns: Json
      }
      onboarding_status_rank: { Args: { _s: string }; Returns: number }
      record_onboarding_reminder: {
        Args: { _investigator_id: string }
        Returns: Json
      }
      revert_curation_change: { Args: { _audit_id: string }; Returns: Json }
      role_owns_questionnaire: { Args: { _role: string }; Returns: boolean }
      search_knowledge_embeddings: {
        Args: {
          match_count?: number
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          content: string
          id: string
          metadata: Json
          similarity: number
          source_id: string
          source_type: string
          title: string
        }[]
      }
      set_actor: { Args: { _label: string }; Returns: string }
      set_onboarding_step: {
        Args: { _investigator_id: string; _status: string; _step: string }
        Returns: Json
      }
      suggest_grants_for_investigator: {
        Args: { _investigator_id: string }
        Returns: {
          grant_id: string
          grant_number: string
          reason: string
          score: number
          title: string
        }[]
      }
      undismiss_group_audit_entry: {
        Args: { _group_email: string; _member_email: string }
        Returns: Json
      }
      upsert_access_request: {
        Args: {
          _association?: string
          _email: string
          _full_name?: string
          _globus_name?: string
          _globus_subject?: string
          _institution?: string
          _message?: string
          _requested_role?: string
        }
        Returns: {
          id: string
          was_created: boolean
        }[]
      }
      user_can_edit_grant_roster: {
        Args: { _grant_id: string; _user_id: string }
        Returns: boolean
      }
      user_can_edit_project: {
        Args: { _grant_number: string; _user_id: string }
        Returns: boolean
      }
      user_can_revert_audit: {
        Args: { _audit_id: string; _user_id: string }
        Returns: boolean
      }
      user_owns_investigator: {
        Args: { _investigator_id: string; _user_id: string }
        Returns: boolean
      }
      user_owns_resource: {
        Args: { _resource_id: string; _user_id: string }
        Returns: boolean
      }
      user_shares_grant_with_investigator: {
        Args: { _editor_id: string; _target_investigator_id: string }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "member" | "curator"
      budget_provider: "github" | "supabase" | "lovable"
      curation_action: "create" | "update" | "delete"
      curation_entity_type:
        | "project_metadata"
        | "team_roster"
        | "pending_change_decision"
        | "investigator"
        | "entity_comment"
      resource_type:
        | "investigator"
        | "organization"
        | "grant"
        | "publication"
        | "software"
        | "tool"
        | "dataset"
        | "protocol"
        | "benchmark"
        | "ml_model"
        | "job"
        | "announcement"
        | "funding"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "member", "curator"],
      budget_provider: ["github", "supabase", "lovable"],
      curation_action: ["create", "update", "delete"],
      curation_entity_type: [
        "project_metadata",
        "team_roster",
        "pending_change_decision",
        "investigator",
        "entity_comment",
      ],
      resource_type: [
        "investigator",
        "organization",
        "grant",
        "publication",
        "software",
        "tool",
        "dataset",
        "protocol",
        "benchmark",
        "ml_model",
        "job",
        "announcement",
        "funding",
      ],
    },
  },
} as const
