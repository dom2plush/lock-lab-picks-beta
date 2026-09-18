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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      follows: {
        Row: {
          created_at: string
          follower_id: string
          following_id: string
        }
        Insert: {
          created_at?: string
          follower_id: string
          following_id: string
        }
        Update: {
          created_at?: string
          follower_id?: string
          following_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "follows_follower_id_fkey"
            columns: ["follower_id"]
            isOneToOne: false
            referencedRelation: "leaderboard"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "follows_follower_id_fkey"
            columns: ["follower_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_following_id_fkey"
            columns: ["following_id"]
            isOneToOne: false
            referencedRelation: "leaderboard"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "follows_following_id_fkey"
            columns: ["following_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      game_analyses: {
        Row: {
          bad_bet: Json | null
          candidate_audit: Json | null
          engine_version: string
          fun_bets: Json
          game_id: string
          generated_at: string
          graded_at: string | null
          id: string
          is_live_odds: boolean
          odds_book: string | null
          odds_captured_at: string | null
          odds_snapshot: Json
          player_props: Json
          sport: string
          top_bets: Json
          top_pick_result: string
          verdict: string | null
        }
        Insert: {
          bad_bet?: Json | null
          candidate_audit?: Json | null
          engine_version?: string
          fun_bets?: Json
          game_id: string
          generated_at?: string
          graded_at?: string | null
          id?: string
          is_live_odds?: boolean
          odds_book?: string | null
          odds_captured_at?: string | null
          odds_snapshot?: Json
          player_props?: Json
          sport: string
          top_bets?: Json
          top_pick_result?: string
          verdict?: string | null
        }
        Update: {
          bad_bet?: Json | null
          candidate_audit?: Json | null
          engine_version?: string
          fun_bets?: Json
          game_id?: string
          generated_at?: string
          graded_at?: string | null
          id?: string
          is_live_odds?: boolean
          odds_book?: string | null
          odds_captured_at?: string | null
          odds_snapshot?: Json
          player_props?: Json
          sport?: string
          top_bets?: Json
          top_pick_result?: string
          verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "game_analyses_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: true
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      game_simulations: {
        Row: {
          aggregate: Json
          analysis_id: string | null
          engine_version: string
          game_id: string
          generated_at: string
          id: string
          input_fingerprint: string
          runs: number
          simulations: Json
          sport: string
        }
        Insert: {
          aggregate?: Json
          analysis_id?: string | null
          engine_version?: string
          game_id: string
          generated_at?: string
          id?: string
          input_fingerprint: string
          runs?: number
          simulations?: Json
          sport: string
        }
        Update: {
          aggregate?: Json
          analysis_id?: string | null
          engine_version?: string
          game_id?: string
          generated_at?: string
          id?: string
          input_fingerprint?: string
          runs?: number
          simulations?: Json
          sport?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_simulations_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "game_analyses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "game_simulations_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      games: {
        Row: {
          away_score: number | null
          away_team: string
          away_team_short: string | null
          commence_time: string
          created_at: string
          home_score: number | null
          home_team: string
          home_team_short: string | null
          id: string
          injuries: Json
          is_demo: boolean
          odds: Json
          odds_book: string | null
          odds_book_key: string | null
          odds_updated_at: string | null
          props: Json
          props_updated_at: string | null
          provider_game_id: string
          sport: string
          status: string
          updated_at: string
        }
        Insert: {
          away_score?: number | null
          away_team: string
          away_team_short?: string | null
          commence_time: string
          created_at?: string
          home_score?: number | null
          home_team: string
          home_team_short?: string | null
          id?: string
          injuries?: Json
          is_demo?: boolean
          odds?: Json
          odds_book?: string | null
          odds_book_key?: string | null
          odds_updated_at?: string | null
          props?: Json
          props_updated_at?: string | null
          provider_game_id: string
          sport: string
          status?: string
          updated_at?: string
        }
        Update: {
          away_score?: number | null
          away_team?: string
          away_team_short?: string | null
          commence_time?: string
          created_at?: string
          home_score?: number | null
          home_team?: string
          home_team_short?: string | null
          id?: string
          injuries?: Json
          is_demo?: boolean
          odds?: Json
          odds_book?: string | null
          odds_book_key?: string | null
          odds_updated_at?: string | null
          props?: Json
          props_updated_at?: string | null
          provider_game_id?: string
          sport?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          username: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          username: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          username?: string
        }
        Relationships: []
      }
      tails: {
        Row: {
          analysis_id: string
          bet_type: string
          created_at: string
          extra_legs: Json
          game_id: string
          id: string
          lock_leg_result: string
          pick_key: string
          pick_label: string
          pick_odds: string | null
          pick_section: string
          user_id: string
          wager: number | null
        }
        Insert: {
          analysis_id: string
          bet_type?: string
          created_at?: string
          extra_legs?: Json
          game_id: string
          id?: string
          lock_leg_result?: string
          pick_key: string
          pick_label: string
          pick_odds?: string | null
          pick_section?: string
          user_id: string
          wager?: number | null
        }
        Update: {
          analysis_id?: string
          bet_type?: string
          created_at?: string
          extra_legs?: Json
          game_id?: string
          id?: string
          lock_leg_result?: string
          pick_key?: string
          pick_label?: string
          pick_odds?: string | null
          pick_section?: string
          user_id?: string
          wager?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tails_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "game_analyses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tails_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tails_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "leaderboard"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "tails_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      leaderboard: {
        Row: {
          display_name: string | null
          followers: number | null
          losses: number | null
          pending: number | null
          pushes: number | null
          total_tails: number | null
          user_id: string | null
          username: string | null
          wins: number | null
        }
        Relationships: []
      }
      lock_lab_records: {
        Row: {
          losses: number | null
          pending: number | null
          pushes: number | null
          sport: string | null
          wins: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
