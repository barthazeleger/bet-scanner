// ── TRANSLATIONS ─────────────────────────────────────────────────────────────
const LANG={nl:{nav_scans:'Scans',nav_tracker:'Tracker',nav_data:'Data',nav_bets:'Mijn Bets',nav_analyse:'Analyse',nav_inbox:'Inbox',nav_status:'Status',nav_info:'Info',nav_more:'Meer',bnav_bets:'Bets',brand_sub:'Picks & Bet Tracker',notif_title:'Notificaties',notif_tooltip:'Notificaties',hero_brand:'EdgePickr \u00b7 AI Betting Engine',hero_loading:'Laden...',hero_quote_tag:'Quote van de dag',hero_bankroll:'Bankroll',hero_roi:'ROI',hero_wl:'Win / Verlies',hero_open:'Open bets',hero_sr:'Strike rate',hero_clv:'Gem. CLV',scan_headline:'Vind de beste bets van dit moment',scan_desc:'Pre-match \u00b7 Live xG \u00b7 H2H \u00b7 Opstellingen \u00b7 Standen \u00b7 Predictions<br>16 competities \u00b7 singles + combi\'s \u00b7 half-Kelly \u00b7 max odds 4.0',scan_start:'Start scan',scan_api_label:'api-football.com',scan_api_loading:'laden...',scan_prev:'Vorige scans',scan_show:'\u25bc toon',scan_hide:'\u25b2 verberg',scan_no_prev:'Nog geen eerdere scans.',scan_restore:'herstel',scan_picks:'pick',scan_picks_plural:'picks',scan_matches:'wedstrijden',scan_no_picks:'Geen picks',potd_btn:'\ud83d\udcdd Genereer POTD post',potd_generating:'\u23f3 Genereren...',potd_reddit:'Reddit post',potd_x_post:'\ud835\udd4f Post',potd_copy:'\ud83d\udccb Kopieer',potd_copied:'\u2705 Gekopieerd!',potd_chars:'tekens',potd_error:'Fout',potd_network_error:'Netwerkfout',picks_none:'\ud83d\udeab Geen overtuigde picks vandaag',picks_found:'overtuigde pick',picks_found_plural:'overtuigde picks',picks_subtitle:'zet alleen deze',picks_chance:'kans',picks_analysis:'analyse',picks_hide_analysis:'\u25b2 analyse verbergen',picks_show_analysis:'\u25bc analyse tonen',picks_logged:'\u2713 Gelogd',picks_now_live:'\u25cf nu bezig',rb_title:'\ud83d\udccb Recente bets',rb_live:'live',rb_all:'Alle \u2192',rb_loading:'Laden...',rb_model_health:'Model gezondheid',rb_run_scan:'Run een scan voor model data.',rb_no_bets_live:'Geen bets nu live.',rb_no_bets:'Nog geen bets.',rb_no_calib:'Nog geen calibratie data.',rb_too_few:'Nog te weinig data per markt.',stat_bankroll:'Bankroll',stat_roi:'ROI',stat_won:'Gewonnen',stat_lost:'Verloren',stat_open:'Open',stat_sr:'Strike Rate',stat_wl:'W/L (\u20ac)',stat_avg_odds:'Gem. odds',tr_results_title:'\ud83d\udd04 Uitslagen ophalen',tr_results_desc:'Check open bets via ESPN \u2014 auto-update W/L waar mogelijk',tr_check:'\ud83d\udce1 Check uitslagen',tr_recalc:'\ud83d\udd27 Herbereken W/L',tr_recalc_busy:'\u23f3 Bezig...',tr_add_bet:'+ Bet toevoegen',tr_expand:'\u25bc Uitklappen',tr_collapse:'\u25b2 Inklappen',tr_add:'Toevoegen',tr_clear:'Wissen',form_datum:'Datum',form_sport:'Sport',form_match:'Wedstrijd',form_market:'Markt / Bet',form_odds:'Odds',form_units:'Units',form_tip:'Tip',form_outcome:'Uitkomst',form_kickoff:'Aftrap',form_fill_match:'\u26a0\ufe0f Vul wedstrijd, odds en units in.',form_bet_added:'\u2705 Bet toegevoegd!',form_bet_added_corr:'\u26a0\ufe0f Bet toegevoegd',sport_football:'Voetbal',sport_tennis:'Tennis',sport_basketball:'Basketball',sport_ice_hockey:'IJshockey',sport_baseball:'Honkbal',sport_rugby:'Rugby',sport_american_football:'American Football',sport_volleyball:'Volleybal',sport_table_tennis:'Tafeltennis',sport_snooker:'Snooker',sport_darts:'Darts',sport_mma:'MMA',sport_boxing:'Boksen',sport_other:'Anders',period_label:'Periode',period_to:'t/m',period_today:'Vandaag',period_all:'Alles',period_compare:'Vergelijk vorige periode',period_backfill:'\u23f0 Tijden invullen',period_backfill_busy:'\u23f3 Bezig...',period_current:'Huidige periode',period_previous:'Vorige periode',period_prev_suffix:'(vorige periode)',period_bets:'Bets',th_nr:'#',th_datum:'Datum',th_kickoff:'Aftrap',th_sport:'Sport',th_match:'Wedstrijd',th_bet:'Bet',th_odds:'Odds',th_units:'Units',th_stake:'Inzet',th_score:'Score',th_outcome:'Uitkomst',th_wl:'W/L',th_clv:'CLV',tbl_no_bets:'Nog geen bets geregistreerd.',tbl_delete:'Verwijderen',tbl_confirm_delete:'Bet #%d verwijderen?',chart_bankroll:'\ud83d\udcc8 Bankroll verloop',chart_outcomes:'\ud83c\udfaf Uitkomsten',chart_sports:'\u26bd Per sport',chart_score:'\ud83d\udcca Hit rate per score (5\u201310)',chart_score_sub:'\u2014 hoe vaak converteert elk cijfer?',chart_market:'\ud83c\udfb2 Hit rate per markttype',chart_market_sub:'\u2014 welke markten presteren het best?',chart_clv:'\ud83d\udcc9 Closing Line Value',chart_clv_sub:'\u2014 versla je de markt?',chart_variance:'\ud83c\udfb2 Variance Tracker',chart_variance_sub:'\u2014 geluk of skill?',chart_signal:'\ud83e\udde0 Signal Attribution',chart_signal_sub:'\u2014 welke signalen werken?',chart_timing:'\u23f0 Timing analyse',chart_timing_sub:'\u2014 CLV per timing bucket',bankroll_label:'Bankroll (\u20ac)',pie_won:'Gewonnen',pie_lost:'Verloren',pie_open:'Open',data_no_score:'Nog geen settled bets met score \u2014 log nieuwe picks via de scan.',data_no_market:'Nog geen settled bets om te analyseren.',data_clv_none:'CLV wordt gemeten bij aftrap \u2014 verschijnt na je eerste afgeronde bets.',data_clv_good:'\u2705 Je logt bets tegen betere odds dan de slotlijn \u2014 dit is het sterkste bewijs van edge.',data_clv_bad:'\u26a0\ufe0f Je odds zijn gemiddeld slechter dan de slotlijn. Probeer eerder te loggen of odds te vergelijken.',data_clv_beat:'Bets die markt verslaan',data_clv_measured:'CLV gemeten',data_avg_clv:'Gem. CLV',data_var_none:'Variance tracker verschijnt na je eerste settled bets.',data_var_actual:'Werkelijk W',data_var_expected:'Verwacht W',data_var_luck:'Luck factor',data_var_settled:'Settled',data_var_luck_pos:'Significant geluk',data_var_luck_neg:'Significant pech',data_var_luck_slight_pos:'Binnen verwachting (licht geluk)',data_var_luck_slight_neg:'Binnen verwachting (licht pech)',data_var_early:'\u23f3 Na 30+ bets wordt de variance tracker betrouwbaar. Nu nog te vroeg om conclusies te trekken.',data_var_ok:'\u2705 Resultaten liggen binnen de verwachte range. Het model presteert consistent.',data_var_slight:'\ud83d\udcca Lichte afwijking \u2014 normaal bij deze sample size. Blijf monitoren.',data_var_above:'\ud83c\udf40 Je draait boven verwachting. Geniet ervan, maar reken niet op deze rate.',data_var_below:'\ud83d\udcc9 Je draait onder verwachting. Als het model CLV-positief is, is dit waarschijnlijk pech.',data_sig_none:'Signal data verschijnt na picks met signal tracking (nieuwe scans).',data_sig_fail:'Signal analyse laden mislukt.',data_tim_none:'Timing data verschijnt zodra er settled bets met CLV en tijdstip zijn.',data_tim_fail:'Timing analyse laden mislukt.',sig_home_adv:'Thuisvoordeel',sig_form:'Vorm',sig_injuries:'Blessures',sig_h2h:'Head-to-head',sig_position:'Positie',sig_home_away_split:'Thuis/uit split',sig_api_pred:'API predictie',sig_lineup:'Opstelling',sig_team_stats:'Team stats',sig_btts_scoring:'BTTS scoring',sig_btts_cleansheet:'BTTS clean sheet',mkt_over:'Over X goals',mkt_under:'Under X goals',mkt_winner:'Wedstrijd winnaar',mkt_draw:'Gelijkspel',mkt_btts:'Beide scoren',mkt_other:'Overig',live_refresh:'Vernieuwen',live_only:'Alleen live',live_my_bets:'Alleen mijn bets',live_auto:'Auto-refresh (10s)',live_loading:'Jouw bets laden...',live_loading_short:'Laden...',live_error:'Fout bij ophalen',live_no_bets:'Geen wedstrijden gevonden voor jouw open bets.',live_no_live:'Geen live wedstrijden op dit moment.',live_click_refresh:'Klik "Vernieuwen" om scores te laden.',live_events:'\u26a1 Gebeurtenissen',live_events_close:'\u26a1 Sluiten',live_events_loading:'Laden\u2026',live_events_none:'Nog geen gebeurtenissen.',live_events_no_data:'Geen data beschikbaar.',live_your_bet:'\u2b50 JOUW BET',live_goals_scored:'goals gescoord',live_line:'lijn',analyse_title:'\ud83d\udd0d Zoek in laatste scan resultaten',analyse_placeholder:'Zoek op team, markt of competitie...',analyse_search:'Zoeken',analyse_hint:'Toont alle picks uit de laatste prematch scan inclusief volledige redenering. Start een scan om data te laden.',analyse_no_data:'Geen scandata beschikbaar. Start eerst een prematch scan.',analyse_no_data_short:'Geen scandata. Start eerst een prematch scan.',analyse_no_results:'Geen resultaten voor',inbox_title:'\ud83d\udcec Inbox',inbox_all:'Alles',inbox_insights:'\ud83d\udca1 Inzichten',inbox_advice:'\ud83c\udfaf Advies',inbox_milestones:'\ud83c\udfc6 Milestones',inbox_calibration:'\ud83e\udde0 Calibratie',inbox_system:'\u2699\ufe0f Systeem',inbox_signal_weights:'\ud83d\udd27 Huidige Signal Gewichten',inbox_signal_desc:'Gewichten worden automatisch aangepast op basis van prestaties. 1.0 = neutraal, >1.0 = versterkt, <1.0 = afgezwakt.',inbox_no_signals:'Nog geen signal data',inbox_signal_after:'Gewichten worden aangepast na 15+ bets per signal.',inbox_market_mult:'\ud83d\udcca Markt Multipliers',inbox_market_desc:'Calibratie per markttype na 8+ bets. Hoog = model vertrouwt deze markt meer.',inbox_no_markets:'Nog geen calibratiedata',inbox_market_after:'Calibratie start na 8+ bets per markttype.',inbox_no_messages:'berichten',inbox_no_insights:'inzichten',inbox_no_advice:'adviezen',inbox_no_milestones:'milestones',inbox_no_calibration:'calibratie updates',inbox_no_system:'systeemmeldingen',inbox_empty_prefix:'Nog geen',inbox_empty_suffix:'\u2014 het systeem leert na elke settled bet.',feed_market_calibration:'Markt calibratie',feed_ep_calibration:'EP herweging',feed_signal_tuning:'Signal tuning',feed_milestone:'Milestone',feed_insight:'Inzicht',feed_timing_insight:'Timing inzicht',feed_clv_insight:'CLV inzicht',feed_performance:'Prestatie analyse',feed_recommendation:'Advies',feed_upgrade_advice:'Upgrade advies',feed_strategy:'Strategie',feed_system:'Systeem',feed_sheets_slow:'Performance',feed_api_warning:'API waarschuwing',feed_model_update:'Model update',mm_home:'\ud83c\udfe0 Thuis wint',mm_away:'\u2708\ufe0f Uit wint',mm_draw:'\ud83e\udd1d Gelijkspel',mm_over:'\u26bd Over',mm_under:'\u26bd Under',mm_btts:'\u26bd BTTS',mm_dnb:'\u26bd Draw No Bet',mm_other:'\ud83d\udccb Overig',status_title:'\ud83d\udfe2 Service Status',status_api:'\ud83d\udcca API Budget',status_model:'\ud83e\udde0 Model Status',status_settled:'Settled bets',status_winrate:'Win rate',status_markets_active:'Markten actief',status_last_calib:'Laatste calibratie',status_not_yet:'nog niet',status_budget_reset:'Budget reset dagelijks om middernacht UTC. Gemiddeld verbruik: ~200-400 calls per scan.',status_budget_high:'\u26a0\ufe0f Hoog verbruik \u2014 beperk handmatige rescans.',status_calls_remaining:'calls resterend',status_used:'gebruikt',status_calls_today:'calls vandaag',status_load_error:'Fout bij laden',info_title:'\ud83c\udfaf EdgePickr \u2014 hoe het werkt',info_sub:'Data-gedreven sportsbetting',info_version:'versie',info_desc:'EdgePickr combineert api-football Pro data met een zelflerend model (11 signalen) om dagelijkse value bets te vinden. Het doel: systematisch edge vinden waar bookmakers het mis hebben, via Kelly Criterion slim inzetten, en met CLV tracking bewijzen dat het werkt.',info_model_title:'\ud83e\udde0 Het model uitgelegd',info_model_1_title:'1. No-vig kans berekening',info_model_1_desc:'Alle bookmaker odds worden genormaliseerd (marge verwijderd). Het gemiddelde over alle books = consensuskans.',info_model_2_title:'2. 11 signalen (api-football Pro)',info_sig_1:'Thuisvoordeel per competitie (2\u20136%)',info_sig_2:'Vorm laatste 5 wedstrijden',info_sig_3:'Head-to-head record + BTTS-rate',info_sig_4:'Competitiestand + positieverschil',info_sig_5:'Home/away goal splits (thuis- vs uitprestaties)',info_sig_6:'Team seizoensstatistieken (goals avg, clean sheet %)',info_sig_7:'Blessures (aantal + impact)',info_sig_8:'Opstelling/rotatie (als lineup beschikbaar)',info_sig_9:'api-football AI predictions',info_sig_10:'Scheidsrechter (data-verzameling)',info_sig_11:'Over/Under team scoring adjustments',info_model_3_title:'3. Kelly Criterion + sizing',info_model_3_desc:'Half-Kelly voor veiligheid. 6 markten: Match Winner, Over/Under, BTTS, Draw No Bet, Handicap, Gelijkspel.',info_model_4_title:'4. Self-learning',info_model_4_desc:'Markt multipliers recalibreren na 8+ bets. Signal gewichten auto-tunen dagelijks. EP-bucket herweging na 100 bets. Alles zichtbaar in de \ud83d\udcec Inbox tab.',info_model_5_title:'5. CLV + Variance tracking',info_model_5_desc:'Slotodds ophalen bij aftrap \u2192 CLV% per bet. Variance tracker meet geluk vs skill (\u03c3-afwijking). Timing analyse toont wanneer je de beste odds pakt.',info_sources_title:'\ud83d\udce1 Databronnen',info_src_primary:'PRIMAIR',info_src_free:'GRATIS',info_src_api_desc:'Odds, fixtures, standings, H2H, blessures, lineups, predictions, team stats, scheidsrechters.',info_src_api_detail:'7.500 calls/dag \u00b7 \u20ac19/mnd \u00b7 40 competities wereldwijd',info_src_espn_desc:'Live scores auto-refresh (elke 30s) op de Mijn Bets tab + uitslagen check.',info_src_espn_detail:'Volledig gratis, onbeperkt, geen key nodig',info_src_tg_desc:'Dagelijkse picks, pre-kickoff checks, CLV meldingen, odds alerts, model updates, milestones.',info_src_tg_detail:'Volledig gratis, onbeperkt',info_src_sheets_desc:'Database voor bets, users, en instellingen. Persisteert over server restarts.',info_src_sheets_detail:'Gratis met Google service account',info_src_odds_replaced:'Vervangen door api-football Pro (meer data, betere dekking)',info_staking_title:'\ud83d\udcb0 Inzetstrategie',info_stake_03:'Kelly < 4% \u00b7 \u20ac3 \u00b7 voorzichtig',info_stake_05:'Kelly 4\u20138% \u00b7 \u20ac5 \u00b7 normaal',info_stake_10:'Kelly 8\u201318% \u00b7 \u20ac10 \u00b7 sterk',info_stake_20:'Kelly > 18% \u00b7 \u20ac20 \u00b7 uitzonderlijk',info_stake_desc:'Startkapitaal \u20ac100 \u00b7 1 unit = \u20ac10 \u00b7 max 5 picks/dag \u00b7 min odds 1.60 \u00b7 min edge 5.5% \u00b7 min trefkans 28%',info_subs_title:'\ud83d\udcb3 Abonnementen',info_sub_api_desc:'7500 req/dag \u00b7 fixtures \u00b7 odds \u00b7 opstellingen \u00b7 predictions \u00b7 xG \u00b7 H2H \u00b7 statistieken',info_sub_claude_desc:'Onbeperkt AI-gebruik \u00b7 bouwt & onderhoudt scanner, dashboard en logica',info_sub_odds_desc:'Odds aggregator \u2014 opgezegd (vervangen door api-football.com)',info_sub_allsports_desc:'NBA \u00b7 NHL \u00b7 NFL \u00b7 MLB + alle voetbalcompetities \u2014 beschikbaar als ROI > 10%',info_sub_start:'Start',info_sub_renews:'Verlengt',info_sub_cancelled:'Opgezegd',info_sub_inactive:'Inactief',info_model_updates:'\ud83e\udde0 Model updates',info_model_new:'nieuw',info_model_no_updates:'Nog geen model updates \u2014 het model leert zodra bets worden afgerond.',info_model_error:'Fout bij ophalen model log.',info_changelog:'\ud83d\udcdd Versiegeschiedenis',cl_v410:'POTD generator, modal herberekening, push fix',cl_v48:'PWA, push notificaties, status pagina, mobile-first',cl_v45:'Mijn Bets tab, correlatie-check, live ESPN, self-learning',cl_v42:'CLV tracking, signal attribution, variance tracker',cl_v41:'Login systeem + account instellingen',cl_v36:'Score & markt analyse + bankroll fix',cl_v35:'Periode filter + vergelijken',cl_v34:'api-football live scores + 40 competities',cl_v33:'Render deploy + dagelijkse scan + bugs + meer competities',cl_v32:'EdgePickr \u2014 volledig herontworpen scanlogica + live dashboard',cl_v31:'Live tab \u2014 gebeurtenissen, stats & xG',cl_v30:'Scanlogica herschreven \u2014 expectedEur + score + history',cl_v29:'Pick cards uitgebreid \u2014 bookmaker, kickoff, payout',cl_v28:'Unified scanner \u2014 pre-match + live in \u00e9\u00e9n pool',cl_v27:'api-football.com migratie + live scan in dagelijkse check',cl_v26:'Pick kwaliteitsfilters + model-update tracking',cl_v25:'Dashboard redesign + Google Sheets + cloud-ready',cl_v24:'Notifications + automatische uitslag check',cl_v23:'Calibratie & zelflerende multipliers',cl_v22:'api-sports.io integratie + live scan rewrite',cl_v21:'The Odds API + pick cards + dashboard',cl_v10:'Eerste versie \u2014 Sofascore + Telegram',prof_settings:'\u2699\ufe0f Instellingen',prof_account:'Account',prof_logged_in:'Ingelogd als',prof_bankroll:'Bankroll & inzet',prof_start_bankroll:'Start bankroll (\u20ac)',prof_unit_size:'Unit grootte (\u20ac)',prof_scan_times:'Dagelijkse scan-tijden',prof_scan_desc:'Selecteer uren waarop de scan automatisch draait en picks naar Telegram stuurt',prof_scan_enabled:'Automatische scans ingeschakeld',prof_lang_region:'Taal & regio',prof_language:'Taal',prof_timezone:'Tijdzone',prof_tz_berlin:'Berlijn (UTC+1/+2)',prof_change_pw:'Wachtwoord wijzigen',prof_current_pw:'Huidig wachtwoord',prof_new_pw:'Nieuw wachtwoord (min. 8 tekens)',prof_change_pw_btn:'Wachtwoord wijzigen',prof_pw_fill:'Vul huidig en nieuw wachtwoord in',prof_pw_changed:'\u2705 Wachtwoord gewijzigd',prof_save:'Opslaan',prof_logout:'Uitloggen',prof_saved:'\u2705 Instellingen opgeslagen',prof_error:'Fout',prof_conn_error:'Verbindingsfout',prof_admin:'\ud83d\udd11 Admin \u2014 Gebruikers',prof_admin_loading:'Laden...',prof_admin_none:'Geen gebruikers',prof_admin_load_error:'Fout bij laden',prof_admin_approve:'\u2713 Goed',prof_admin_active:'\u2713 Actief',prof_admin_blocked:'Geblokkeerd',prof_admin_block:'Blokkeer',prof_admin_registered:'aangemeld',modal_title:'\u2795 Pick loggen als bet',modal_match:'Wedstrijd',modal_market:'Markt',modal_odds:'Odds',modal_odds_adjustable:'(aanpasbaar)',modal_units:'Units',modal_sport:'Sport',modal_kickoff:'Aftrap',modal_kickoff_hint:'(HH:MM \u00b7 voor pre-kickoff check)',modal_datum:'Datum',modal_stake:'Inzet',modal_payout:'Uitbetaling',modal_profit:'winst',modal_log:'Bet loggen',modal_cancel:'Annuleren',modal_fill_odds:'\u26a0\ufe0f Vul odds in.',modal_logged:'\u2705 Bet gelogd!',modal_logged_corr:'\u26a0\ufe0f Gelogd',modal_recommended:'aanbevolen',notif_ok:'\u2705 Alles in orde \u2014 geen meldingen.',notif_error:'Fout bij ophalen notificaties.',notif_model_bets:'bets in model',notif_model_updated:'model bijgewerkt',notif_updated:'bijgewerkt',notif_no_data:'nog geen data',check_loading:'Ophalen...',check_no_open:'\u2705 Geen open bets.',check_no_finished:'open bets \u2014 geen afgeronde wedstrijden gevonden (te vroeg?).',check_updated:'automatisch bijgewerkt',check_scores_found:'\ud83d\udccb Scores gevonden \u2014 zie hieronder',check_results_title:'\ud83d\udccb Gevonden resultaten',check_recalc_done:'W/L waarden herberekend',check_error:'Fout',check_network_error:'Netwerkfout',corr_title:'\u26a0 Gecorreleerde bets',corr_bets:'bets',corr_exposure:'exposure',bf_updated:'bijgewerkt',bf_not_found:'niet gevonden',bf_error:'Fout',bf_network:'Netwerkfout',conn_error:'Verbindingsfout',day_sun:'zondag',day_mon:'maandag',day_tue:'dinsdag',day_wed:'woensdag',day_thu:'donderdag',day_fri:'vrijdag',day_sat:'zaterdag',mon_jan:'jan',mon_feb:'feb',mon_mar:'mrt',mon_apr:'apr',mon_may:'mei',mon_jun:'jun',mon_jul:'jul',mon_aug:'aug',mon_sep:'sep',mon_oct:'okt',mon_nov:'nov',mon_dec:'dec',ago_just_now:'zojuist',ago_min:'min geleden',ago_hour:'uur geleden',ago_day:'dag geleden',hit_rate:'hit rate',mc_own_goal:'Eigen doelpunt',mc_xg:'xG (schatting)',mc_possession:'Balbezit %',mc_shots:'Schoten',mc_shots_on:'Op doel',mc_blocked:'Geblokt',mc_corners:'Hoekschoppen',mc_fouls:'Overtredingen',mc_yellows:'Gele kaarten',mc_reds:'Rode kaarten',mc_offsides:'Buitenspel',mc_saves:'Reddingen',quote_1:'Het huis wint altijd \u2014 tenzij je een edge hebt.',quote_2:'In God we trust. All others must bring data.',quote_3:'Value is not in the odds, it\'s in the edge.',quote_4:'Discipline beats conviction every single time.',quote_5:'Een verlies is data. Twee op rij ook. Drie op rij: kijk naar het model.',quote_6:'De bookmaker heeft een marge. Wij hebben een algoritme.',quote_7:'Geduld is geen passiviteit \u2014 het is strategisch wachten.',quote_8:'Kleine edges, consistent toegepast, winnen van geluk op de lange termijn.',quote_9:'Bet with your head, not over it.',quote_10:'Statistics are the grammar of science.',quote_11:'Het model heeft geen gevoel. Dat is het voordeel.',quote_12:'ROI over 50 bets zegt meer dan ROI over 5.',notif_just_now:'zojuist',notif_notification:'Notificatie',notif_model_alerts:'Model alerts',notif_more_info:'Meer info \u2192',notif_all_clear:'\u2705 Alles in orde \u2014 geen meldingen.',notif_error:'Fout bij ophalen notificaties.',prof_security:'Beveiliging',prof_2fa_toggle:'2FA inschakelen (email verificatie bij login)',prof_2fa_desc:'Bij inloggen ontvang je een 6-cijferige code per email'},en:{nav_scans:'Scans',nav_tracker:'Tracker',nav_data:'Data',nav_bets:'My Bets',nav_analyse:'Analysis',nav_inbox:'Inbox',nav_status:'Status',nav_info:'Info',nav_more:'More',bnav_bets:'Bets',brand_sub:'Picks & Bet Tracker',notif_title:'Notifications',notif_tooltip:'Notifications',hero_brand:'EdgePickr \u00b7 AI Betting Engine',hero_loading:'Loading...',hero_quote_tag:'Quote of the day',hero_bankroll:'Bankroll',hero_roi:'ROI',hero_wl:'Win / Loss',hero_open:'Open bets',hero_sr:'Strike rate',hero_clv:'Avg. CLV',scan_headline:'Find the best bets<br>right now',scan_desc:'Pre-match \u00b7 Live xG \u00b7 H2H \u00b7 Lineups \u00b7 Standings \u00b7 Predictions<br>16 leagues \u00b7 singles + combos \u00b7 half-Kelly \u00b7 max odds 4.0',scan_start:'Start scan',scan_api_label:'api-football.com',scan_api_loading:'loading...',scan_prev:'Previous scans',scan_show:'\u25bc show',scan_hide:'\u25b2 hide',scan_no_prev:'No previous scans yet.',scan_restore:'restore',scan_picks:'pick',scan_picks_plural:'picks',scan_matches:'matches',scan_no_picks:'No picks',potd_btn:'\ud83d\udcdd Generate POTD post',potd_generating:'\u23f3 Generating...',potd_reddit:'Reddit post',potd_x_post:'\ud835\udd4f Post',potd_copy:'\ud83d\udccb Copy',potd_copied:'\u2705 Copied!',potd_chars:'chars',potd_error:'Error',potd_network_error:'Network error',picks_none:'\ud83d\udeab No confident picks today',picks_found:'confident pick',picks_found_plural:'confident picks',picks_subtitle:'bet only these',picks_chance:'chance',picks_analysis:'analysis',picks_hide_analysis:'\u25b2 hide analysis',picks_show_analysis:'\u25bc show analysis',picks_logged:'\u2713 Logged',picks_now_live:'\u25cf live now',rb_title:'\ud83d\udccb Recent bets',rb_live:'live',rb_all:'All \u2192',rb_loading:'Loading...',rb_model_health:'Model health',rb_run_scan:'Run a scan for model data.',rb_no_bets_live:'No bets currently live.',rb_no_bets:'No bets yet.',rb_no_calib:'No calibration data yet.',rb_too_few:'Not enough data per market yet.',stat_bankroll:'Bankroll',stat_roi:'ROI',stat_won:'Won',stat_lost:'Lost',stat_open:'Open',stat_sr:'Strike Rate',stat_wl:'P/L (\u20ac)',stat_avg_odds:'Avg. odds',tr_results_title:'\ud83d\udd04 Fetch results',tr_results_desc:'Check open bets via ESPN \u2014 auto-update P/L where possible',tr_check:'\ud83d\udce1 Check results',tr_recalc:'\ud83d\udd27 Recalculate P/L',tr_recalc_busy:'\u23f3 Working...',tr_add_bet:'+ Add bet',tr_expand:'\u25bc Expand',tr_collapse:'\u25b2 Collapse',tr_add:'Add',tr_clear:'Clear',form_datum:'Date',form_sport:'Sport',form_match:'Match',form_market:'Market / Bet',form_odds:'Odds',form_units:'Units',form_tip:'Tip',form_outcome:'Outcome',form_kickoff:'Kick-off',form_fill_match:'\u26a0\ufe0f Fill in match, odds and units.',form_bet_added:'\u2705 Bet added!',form_bet_added_corr:'\u26a0\ufe0f Bet added',sport_football:'Football',sport_tennis:'Tennis',sport_basketball:'Basketball',sport_ice_hockey:'Ice Hockey',sport_baseball:'Baseball',sport_rugby:'Rugby',sport_american_football:'American Football',sport_volleyball:'Volleyball',sport_table_tennis:'Table Tennis',sport_snooker:'Snooker',sport_darts:'Darts',sport_mma:'MMA',sport_boxing:'Boxing',sport_other:'Other',period_label:'Period',period_to:'to',period_today:'Today',period_all:'All',period_compare:'Compare previous period',period_backfill:'\u23f0 Fill in times',period_backfill_busy:'\u23f3 Working...',period_current:'Current period',period_previous:'Previous period',period_prev_suffix:'(previous period)',period_bets:'Bets',th_nr:'#',th_datum:'Date',th_kickoff:'Kick-off',th_sport:'Sport',th_match:'Match',th_bet:'Bet',th_odds:'Odds',th_units:'Units',th_stake:'Stake',th_score:'Score',th_outcome:'Outcome',th_wl:'P/L',th_clv:'CLV',tbl_no_bets:'No bets registered yet.',tbl_delete:'Delete',tbl_confirm_delete:'Delete bet #%d?',chart_bankroll:'\ud83d\udcc8 Bankroll history',chart_outcomes:'\ud83c\udfaf Outcomes',chart_sports:'\u26bd By sport',chart_score:'\ud83d\udcca Hit rate per score (5\u201310)',chart_score_sub:'\u2014 how often does each score convert?',chart_market:'\ud83c\udfb2 Hit rate per market type',chart_market_sub:'\u2014 which markets perform best?',chart_clv:'\ud83d\udcc9 Closing Line Value',chart_clv_sub:'\u2014 are you beating the market?',chart_variance:'\ud83c\udfb2 Variance Tracker',chart_variance_sub:'\u2014 luck or skill?',chart_signal:'\ud83e\udde0 Signal Attribution',chart_signal_sub:'\u2014 which signals work?',chart_timing:'\u23f0 Timing analysis',chart_timing_sub:'\u2014 CLV per timing bucket',bankroll_label:'Bankroll (\u20ac)',pie_won:'Won',pie_lost:'Lost',pie_open:'Open',data_no_score:'No settled bets with score yet \u2014 log new picks via the scanner.',data_no_market:'No settled bets to analyze yet.',data_clv_none:'CLV is measured at kick-off \u2014 appears after your first settled bets.',data_clv_good:'\u2705 You are logging bets at better odds than the closing line \u2014 this is the strongest proof of edge.',data_clv_bad:'\u26a0\ufe0f Your odds are on average worse than the closing line. Try logging earlier or comparing odds.',data_clv_beat:'Bets beating the market',data_clv_measured:'CLV measured',data_avg_clv:'Avg. CLV',data_var_none:'Variance tracker appears after your first settled bets.',data_var_actual:'Actual W',data_var_expected:'Expected W',data_var_luck:'Luck factor',data_var_settled:'Settled',data_var_luck_pos:'Significant luck',data_var_luck_neg:'Significant bad luck',data_var_luck_slight_pos:'Within expectations (slight luck)',data_var_luck_slight_neg:'Within expectations (slight bad luck)',data_var_early:'\u23f3 After 30+ bets the variance tracker becomes reliable. Too early to draw conclusions.',data_var_ok:'\u2705 Results are within the expected range. The model is performing consistently.',data_var_slight:'\ud83d\udcca Slight deviation \u2014 normal at this sample size. Keep monitoring.',data_var_above:'\ud83c\udf40 You are running above expectation. Enjoy it, but don\'t count on this rate.',data_var_below:'\ud83d\udcc9 You are running below expectation. If the model is CLV-positive, this is likely just bad luck.',data_sig_none:'Signal data appears after picks with signal tracking (new scans).',data_sig_fail:'Failed to load signal analysis.',data_tim_none:'Timing data appears once there are settled bets with CLV and timestamps.',data_tim_fail:'Failed to load timing analysis.',sig_home_adv:'Home advantage',sig_form:'Form',sig_injuries:'Injuries',sig_h2h:'Head-to-head',sig_position:'Position',sig_home_away_split:'Home/away split',sig_api_pred:'API prediction',sig_lineup:'Lineup',sig_team_stats:'Team stats',sig_btts_scoring:'BTTS scoring',sig_btts_cleansheet:'BTTS clean sheet',mkt_over:'Over X goals',mkt_under:'Under X goals',mkt_winner:'Match winner',mkt_draw:'Draw',mkt_btts:'Both teams to score',mkt_other:'Other',live_refresh:'Refresh',live_only:'Live only',live_my_bets:'My bets only',live_auto:'Auto-refresh (10s)',live_loading:'Loading your bets...',live_loading_short:'Loading...',live_error:'Error fetching data',live_no_bets:'No matches found for your open bets.',live_no_live:'No live matches at this time.',live_click_refresh:'Click "Refresh" to load scores.',live_events:'\u26a1 Events',live_events_close:'\u26a1 Close',live_events_loading:'Loading\u2026',live_events_none:'No events yet.',live_events_no_data:'No data available.',live_your_bet:'\u2b50 YOUR BET',live_goals_scored:'goals scored',live_line:'line',analyse_title:'\ud83d\udd0d Search latest scan results',analyse_placeholder:'Search by team, market or league...',analyse_search:'Search',analyse_hint:'Shows all picks from the latest prematch scan including full reasoning. Start a scan to load data.',analyse_no_data:'No scan data available. Start a prematch scan first.',analyse_no_data_short:'No scan data. Start a prematch scan first.',analyse_no_results:'No results for',inbox_title:'\ud83d\udcec Inbox',inbox_all:'All',inbox_insights:'\ud83d\udca1 Insights',inbox_advice:'\ud83c\udfaf Advice',inbox_milestones:'\ud83c\udfc6 Milestones',inbox_calibration:'\ud83e\udde0 Calibration',inbox_system:'\u2699\ufe0f System',inbox_signal_weights:'\ud83d\udd27 Current Signal Weights',inbox_signal_desc:'Weights are automatically adjusted based on performance. 1.0 = neutral, >1.0 = amplified, <1.0 = dampened.',inbox_no_signals:'No signal data yet',inbox_signal_after:'Weights are adjusted after 15+ bets per signal.',inbox_market_mult:'\ud83d\udcca Market Multipliers',inbox_market_desc:'Calibration per market type after 8+ bets. High = model trusts this market more.',inbox_no_markets:'No calibration data yet',inbox_market_after:'Calibration starts after 8+ bets per market type.',inbox_no_messages:'messages',inbox_no_insights:'insights',inbox_no_advice:'advice',inbox_no_milestones:'milestones',inbox_no_calibration:'calibration updates',inbox_no_system:'system messages',inbox_empty_prefix:'No',inbox_empty_suffix:'yet \u2014 the system learns after each settled bet.',feed_market_calibration:'Market calibration',feed_ep_calibration:'EP reweighting',feed_signal_tuning:'Signal tuning',feed_milestone:'Milestone',feed_insight:'Insight',feed_timing_insight:'Timing insight',feed_clv_insight:'CLV insight',feed_performance:'Performance analysis',feed_recommendation:'Advice',feed_upgrade_advice:'Upgrade advice',feed_strategy:'Strategy',feed_system:'System',feed_sheets_slow:'Performance',feed_api_warning:'API warning',feed_model_update:'Model update',mm_home:'\ud83c\udfe0 Home wins',mm_away:'\u2708\ufe0f Away wins',mm_draw:'\ud83e\udd1d Draw',mm_over:'\u26bd Over',mm_under:'\u26bd Under',mm_btts:'\u26bd BTTS',mm_dnb:'\u26bd Draw No Bet',mm_other:'\ud83d\udccb Other',status_title:'\ud83d\udfe2 Service Status',status_api:'\ud83d\udcca API Budget',status_model:'\ud83e\udde0 Model Status',status_settled:'Settled bets',status_winrate:'Win rate',status_markets_active:'Markets active',status_last_calib:'Last calibration',status_not_yet:'not yet',status_budget_reset:'Budget resets daily at midnight UTC. Average usage: ~200-400 calls per scan.',status_budget_high:'\u26a0\ufe0f High usage \u2014 limit manual rescans.',status_calls_remaining:'calls remaining',status_used:'used',status_calls_today:'calls today',status_load_error:'Error loading',info_title:'\ud83c\udfaf EdgePickr \u2014 how it works',info_sub:'Data-driven sportsbetting',info_version:'version',info_desc:'EdgePickr combines api-football Pro data with a self-learning model (11 signals) to find daily value bets. The goal: systematically find edge where bookmakers are wrong, size bets smartly via Kelly Criterion, and prove it works with CLV tracking.',info_model_title:'\ud83e\udde0 The model explained',info_model_1_title:'1. No-vig probability calculation',info_model_1_desc:'All bookmaker odds are normalized (margin removed). The average across all books = consensus probability.',info_model_2_title:'2. 11 signals (api-football Pro)',info_sig_1:'Home advantage per league (2\u20136%)',info_sig_2:'Form last 5 matches',info_sig_3:'Head-to-head record + BTTS rate',info_sig_4:'League standings + position difference',info_sig_5:'Home/away goal splits (home vs away performance)',info_sig_6:'Team season statistics (goals avg, clean sheet %)',info_sig_7:'Injuries (count + impact)',info_sig_8:'Lineup/rotation (when lineup available)',info_sig_9:'api-football AI predictions',info_sig_10:'Referee (data collection)',info_sig_11:'Over/Under team scoring adjustments',info_model_3_title:'3. Kelly Criterion + sizing',info_model_3_desc:'Half-Kelly for safety. 6 markets: Match Winner, Over/Under, BTTS, Draw No Bet, Handicap, Draw.',info_model_4_title:'4. Self-learning',info_model_4_desc:'Market multipliers recalibrate after 8+ bets. Signal weights auto-tune daily. EP-bucket reweighting after 100 bets. All visible in the \ud83d\udcec Inbox tab.',info_model_5_title:'5. CLV + Variance tracking',info_model_5_desc:'Closing odds fetched at kick-off \u2192 CLV% per bet. Variance tracker measures luck vs skill (\u03c3-deviation). Timing analysis shows when you get the best odds.',info_sources_title:'\ud83d\udce1 Data sources',info_src_primary:'PRIMARY',info_src_free:'FREE',info_src_api_desc:'Odds, fixtures, standings, H2H, injuries, lineups, predictions, team stats, referees.',info_src_api_detail:'7,500 calls/day \u00b7 \u20ac19/mo \u00b7 40 leagues worldwide',info_src_espn_desc:'Live scores auto-refresh (every 30s) on the My Bets tab + results check.',info_src_espn_detail:'Completely free, unlimited, no key needed',info_src_tg_desc:'Daily picks, pre-kickoff checks, CLV alerts, odds alerts, model updates, milestones.',info_src_tg_detail:'Completely free, unlimited',info_src_sheets_desc:'Database for bets, users, and settings. Persists across server restarts.',info_src_sheets_detail:'Free with Google service account',info_src_odds_replaced:'Replaced by api-football Pro (more data, better coverage)',info_staking_title:'\ud83d\udcb0 Staking strategy',info_stake_03:'Kelly < 4% \u00b7 \u20ac3 \u00b7 cautious',info_stake_05:'Kelly 4\u20138% \u00b7 \u20ac5 \u00b7 normal',info_stake_10:'Kelly 8\u201318% \u00b7 \u20ac10 \u00b7 strong',info_stake_20:'Kelly > 18% \u00b7 \u20ac20 \u00b7 exceptional',info_stake_desc:'Starting capital \u20ac100 \u00b7 1 unit = \u20ac10 \u00b7 max 5 picks/day \u00b7 min odds 1.60 \u00b7 min edge 5.5% \u00b7 min hit rate 28%',info_subs_title:'\ud83d\udcb3 Subscriptions',info_sub_api_desc:'7500 req/day \u00b7 fixtures \u00b7 odds \u00b7 lineups \u00b7 predictions \u00b7 xG \u00b7 H2H \u00b7 statistics',info_sub_claude_desc:'Unlimited AI usage \u00b7 builds & maintains scanner, dashboard and logic',info_sub_odds_desc:'Odds aggregator \u2014 cancelled (replaced by api-football.com)',info_sub_allsports_desc:'NBA \u00b7 NHL \u00b7 NFL \u00b7 MLB + all football leagues \u2014 available when ROI > 10%',info_sub_start:'Start',info_sub_renews:'Renews',info_sub_cancelled:'Cancelled',info_sub_inactive:'Inactive',info_model_updates:'\ud83e\udde0 Model updates',info_model_new:'new',info_model_no_updates:'No model updates yet \u2014 the model learns once bets are settled.',info_model_error:'Failed to load model log.',info_changelog:'\ud83d\udcdd Version history',cl_v410:'POTD generator, modal recalculation, push fix',cl_v48:'PWA, push notifications, status page, mobile-first',cl_v45:'My Bets tab, correlation check, live ESPN, self-learning',cl_v42:'CLV tracking, signal attribution, variance tracker',cl_v41:'Login system + account settings',cl_v36:'Score & market analysis + bankroll fix',cl_v35:'Period filter + comparison',cl_v34:'api-football live scores + 40 leagues',cl_v33:'Render deploy + daily scan + bugs + more leagues',cl_v32:'EdgePickr \u2014 fully redesigned scan logic + live dashboard',cl_v31:'Live tab \u2014 events, stats & xG',cl_v30:'Scan logic rewritten \u2014 expectedEur + score + history',cl_v29:'Pick cards expanded \u2014 bookmaker, kickoff, payout',cl_v28:'Unified scanner \u2014 pre-match + live in one pool',cl_v27:'api-football.com migration + live scan in daily check',cl_v26:'Pick quality filters + model-update tracking',cl_v25:'Dashboard redesign + Google Sheets + cloud-ready',cl_v24:'Notifications + automatic results check',cl_v23:'Calibration & self-learning multipliers',cl_v22:'api-sports.io integration + live scan rewrite',cl_v21:'The Odds API + pick cards + dashboard',cl_v10:'First version \u2014 Sofascore + Telegram',prof_settings:'\u2699\ufe0f Settings',prof_account:'Account',prof_logged_in:'Logged in as',prof_bankroll:'Bankroll & staking',prof_start_bankroll:'Start bankroll (\u20ac)',prof_unit_size:'Unit size (\u20ac)',prof_scan_times:'Daily scan times',prof_scan_desc:'Select hours when the scan runs automatically and sends picks to Telegram',prof_scan_enabled:'Automatic scans enabled',prof_lang_region:'Language & region',prof_language:'Language',prof_timezone:'Timezone',prof_tz_berlin:'Berlin (UTC+1/+2)',prof_change_pw:'Change password',prof_current_pw:'Current password',prof_new_pw:'New password (min. 8 chars)',prof_change_pw_btn:'Change password',prof_pw_fill:'Fill in current and new password',prof_pw_changed:'\u2705 Password changed',prof_save:'Save',prof_logout:'Log out',prof_saved:'\u2705 Settings saved',prof_error:'Error',prof_conn_error:'Connection error',prof_admin:'\ud83d\udd11 Admin \u2014 Users',prof_admin_loading:'Loading...',prof_admin_none:'No users',prof_admin_load_error:'Error loading',prof_admin_approve:'\u2713 Approve',prof_admin_active:'\u2713 Active',prof_admin_blocked:'Blocked',prof_admin_block:'Block',prof_admin_registered:'registered',modal_title:'\u2795 Log pick as bet',modal_match:'Match',modal_market:'Market',modal_odds:'Odds',modal_odds_adjustable:'(adjustable)',modal_units:'Units',modal_sport:'Sport',modal_kickoff:'Kick-off',modal_kickoff_hint:'(HH:MM \u00b7 for pre-kickoff check)',modal_datum:'Date',modal_stake:'Stake',modal_payout:'Payout',modal_profit:'profit',modal_log:'Log bet',modal_cancel:'Cancel',modal_fill_odds:'\u26a0\ufe0f Fill in odds.',modal_logged:'\u2705 Bet logged!',modal_logged_corr:'\u26a0\ufe0f Logged',modal_recommended:'recommended',notif_ok:'\u2705 All good \u2014 no notifications.',notif_error:'Error loading notifications.',notif_model_bets:'bets in model',notif_model_updated:'model updated',notif_updated:'updated',notif_no_data:'no data yet',check_loading:'Fetching...',check_no_open:'\u2705 No open bets.',check_no_finished:'open bets \u2014 no finished matches found (too early?).',check_updated:'automatically updated',check_scores_found:'\ud83d\udccb Scores found \u2014 see below',check_results_title:'\ud83d\udccb Found results',check_recalc_done:'P/L values recalculated',check_error:'Error',check_network_error:'Network error',corr_title:'\u26a0 Correlated bets',corr_bets:'bets',corr_exposure:'exposure',bf_updated:'updated',bf_not_found:'not found',bf_error:'Error',bf_network:'Network error',conn_error:'Connection error',day_sun:'Sunday',day_mon:'Monday',day_tue:'Tuesday',day_wed:'Wednesday',day_thu:'Thursday',day_fri:'Friday',day_sat:'Saturday',mon_jan:'Jan',mon_feb:'Feb',mon_mar:'Mar',mon_apr:'Apr',mon_may:'May',mon_jun:'Jun',mon_jul:'Jul',mon_aug:'Aug',mon_sep:'Sep',mon_oct:'Oct',mon_nov:'Nov',mon_dec:'Dec',ago_just_now:'just now',ago_min:'min ago',ago_hour:'hours ago',ago_day:'days ago',hit_rate:'hit rate',mc_own_goal:'Own goal',mc_xg:'xG (estimate)',mc_possession:'Possession %',mc_shots:'Shots',mc_shots_on:'On target',mc_blocked:'Blocked',mc_corners:'Corners',mc_fouls:'Fouls',mc_yellows:'Yellow cards',mc_reds:'Red cards',mc_offsides:'Offsides',mc_saves:'Saves',quote_1:'The house always wins \u2014 unless you have an edge.',quote_2:'In God we trust. All others must bring data.',quote_3:'Value is not in the odds, it\'s in the edge.',quote_4:'Discipline beats conviction every single time.',quote_5:'A loss is data. Two in a row, too. Three in a row: check the model.',quote_6:'The bookmaker has a margin. We have an algorithm.',quote_7:'Patience is not passivity \u2014 it is strategic waiting.',quote_8:'Small edges, consistently applied, beat luck in the long run.',quote_9:'Bet with your head, not over it.',quote_10:'Statistics are the grammar of science.',quote_11:'The model has no feelings. That is the advantage.',quote_12:'ROI over 50 bets says more than ROI over 5.',notif_just_now:'just now',notif_notification:'Notification',notif_model_alerts:'Model alerts',notif_more_info:'More info \u2192',notif_all_clear:'\u2705 All good \u2014 no notifications.',notif_error:'Error loading notifications.',prof_security:'Security',prof_2fa_toggle:'Enable 2FA (email verification on login)',prof_2fa_desc:'You will receive a 6-digit code via email when logging in'}};

// ── Extra translations ──
Object.assign(LANG.nl, {
  picks_none: 'Geen overtuigde picks vandaag',
  picks_count: 'overtuigde pick',
  picks_only_these: 'zet alleen deze',
  picks_see_also: 'Zie ook:',
  notif_detail_title: 'Notificatie',
  settings_title: 'Instellingen',
  settings_back: 'Terug',
  nav_settings: 'Instellingen',
  prof_account: 'Account',
  prof_logged_in_as: 'Ingelogd als',
  prof_bankroll: 'Bankroll & inzet',
  prof_start_bankroll: 'Start bankroll (€)',
  prof_unit_size: 'Unit grootte (€)',
  prof_scan_times: 'Dagelijkse scan-tijden',
  prof_scan_times_desc: 'Selecteer uren waarop de scan automatisch draait en picks naar je toestel stuurt (web-push + inbox)',
  prof_scan_enabled: 'Automatische scans ingeschakeld',
  prof_lang_region: 'Taal & regio',
  prof_language: 'Taal',
  prof_timezone: 'Tijdzone',
  prof_change_pw: 'Wachtwoord wijzigen',
  prof_cur_pw: 'Huidig wachtwoord',
  prof_new_pw: 'Nieuw wachtwoord (min. 8 tekens)',
  prof_change_pw_btn: 'Wachtwoord wijzigen',
  prof_save: 'Opslaan',
  prof_logout: 'Uitloggen',
  analyze_title: '\ud83d\udd0d Wedstrijd Analyser',
  analyze_btn: 'Analyseer',
  analyze_placeholder: 'Bijv: Ajax PSV over 2.5',
  analyze_help: 'Typ een wedstrijd + markt. Voorbeelden: "Feyenoord NEC gelijkspel", "Liverpool Arsenal over 2.5", "Bayern btts"',
  analyze_busy: 'Bezig...',
  analyze_analyzing: 'Analyseren...',
  analyze_failed: 'Analyse mislukt',
  analyze_no_edge: 'Geen edge gevonden. De bookmaker-odds lijken correct geprijsd.',
  analyze_form: 'Vorm',
  analyze_standings: 'Stand',
  analyze_h2h: 'Onderlinge resultaten',
  analyze_injuries: 'Blessures',
  analyze_weather: 'Weer',
  analyze_all_markets: 'Alle markten geanalyseerd',
  analyze_log: '+ Log',
  pot_win_today: 'Pot. winst vandaag',
  pot_risk_today: 'Risico',
  sport_football: 'Voetbal',
  sport_basketball: 'Basketball',
  sport_hockey: 'Hockey',
  sport_baseball: 'Baseball',
  sport_nfl: 'NFL',
  sport_handball: 'Handbal',
  api_total: 'Totaal',
  api_budget_reset: 'Budget reset dagelijks om middernacht UTC. Gemiddeld verbruik: ~200-400 calls per scan.',
  api_budget_high: 'Hoog verbruik — beperk handmatige rescans.',
  // ─── v10.5 i18n expansion (card titles + JS maps + options) ───
  nav_model: 'Model',
  card_recent_bets: 'Recente bets',
  card_model_health: 'Model health',
  card_fetch_results: '🔄 Uitslagen ophalen',
  card_add_bet: '+ Bet toevoegen',
  card_bankroll: '📈 Bankroll verloop',
  card_outcomes: '🎯 Uitkomsten',
  card_per_sport: '⚽ Per sport',
  card_hitrate_score: '📊 Hit rate per score',
  card_hitrate_market: '🎲 Hit rate per markttype',
  card_clv: '📉 Closing Line Value',
  card_variance: '🎲 Variance Tracker',
  card_signal_attribution: '🧠 Signal Attribution',
  card_signal_attribution_sub: 'Hit rate per signal — welke signalen leveren echt edge.',
  card_timing: '⏱️ Timing analyse',
  card_analyzer: '🔍 Wedstrijd Analyser',
  card_search_scan: '🔍 Zoek in laatste scan resultaten',
  card_inbox: '📬 Inbox',
  card_signal_weights: '🔧 Huidige Signal Gewichten',
  card_signal_weights_sub: 'Gewichten worden automatisch aangepast op basis van prestaties. 1.0 = neutraal, >1.0 = versterkt, <1.0 = afgezwakt, 0 = inactief (logged-only).',
  card_market_multipliers: '📊 Markt Multipliers',
  card_market_multipliers_sub: 'Calibratie per markttype na 8+ bets. Hoog = model vertrouwt deze markt meer.',
  card_per_sport_sub: 'Win rate en P/L per sport, gebaseerd op settled bets.',
  card_model_updates: '🧠 Model updates',
  card_experimental: '🧪 Experimentele signalen',
  card_experimental_sub: 'Worden verzameld bij elke scan maar staan op weight=0 (geen scoring impact). Auto-activeren naar 0.5 zodra n≥50 picks + avg CLV > 0%. Web-push + inbox melding bij activatie.',
  card_v2_health: '🧪 v2 Pipeline Health',
  card_service_status: '🟢 Service Status',
  card_api_budget: '📊 API Budget',
  card_model_status: '🧠 Model Status',
  card_leagues: '⚽ Competities',
  card_how_it_works: '🎯 EdgePickr — hoe het werkt',
  card_model_explained: '🧠 Het model uitgelegd',
  card_datasources: '📡 Databronnen',
  card_bet_strategy: '💰 Inzetstrategie',
  card_subscriptions: '💳 Abonnementen',
  card_changelog: '📝 Versiegeschiedenis',
  info_subtitle: 'Data-gedreven sportsbetting',
  info_date: 'april 2026',
  info_intro: 'EdgePickr is een <strong>quantitative market-disagreement engine</strong> voor 6 sporten. Markt = baseline truth, model = residual overlay. Volledig autonoom met point-in-time snapshots, CLV-first KPI, kill-switch enforcement, en minimale operator failsafes voor noodgevallen. Doel: systematisch mispricings vinden, niet "voorspellen wie wint".',
  info_model_body: `
    <div style="margin-bottom:10px"><strong style="color:var(--text)">1. Markt-consensus als baseline</strong><br>
    Per fixture worden alle bookmaker odds gedevigd (marge verwijderd) → fair market probability. Dit is de "truth anchor".</div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">2. Model = residual overlay (niet vervanging)</strong><br>
    Per sport een eigen Poisson/regression overlay die de markt-baseline aanpast. Final prob = market + delta. Sanity check: >4% divergentie tussen model en markt → pick wordt geweigerd.</div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">3. Sport-specifieke signalen</strong><br>
    <ul style="padding-left:18px;margin-top:6px;column-count:2;column-gap:24px">
      <li>Voetbal: form, H2H, blessures, lineup, ref, predictions, weer, Poisson goals</li>
      <li>NHL: shots-differential (nhl.com), home-ice, b2b, 3-way Poisson</li>
      <li>MLB: starting pitcher ERA (statsapi.mlb.com), F5 markt</li>
      <li>NBA: pace/PPG, rebound diff, home split</li>
      <li>NFL: bye week, division rivalry, points diff</li>
      <li>Handbal: 3-way Poisson, momentum</li>
      <li>Hierarchical calibration: global → sport → markt → league</li>
      <li>Per-signal CLV autotune (sneller dan W/L)</li>
    </ul>
    </div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">4. Half-Kelly + diversification</strong><br>
    <code style="background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:11.5px">k = (ep×(odd-1) − (1−ep)) / (odd-1) × 0.5</code><br>
    Markten: Moneyline, 3-way ML 60-min (hockey/handbal), Totals, Spreads, Team Totals, BTTS, Double Chance, DNB, F5 (MLB), 1st Period O/U.<br>
    Diversification: max 1 pick per match, max 2 per sport per dag, max 5 picks/dag totaal.</div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">5. Discipline mechanismen (auto)</strong><br>
    • Kill-switch: markten met avg CLV < -5% (n≥30) auto-disabled<br>
    • Signal kill: signalen met avg CLV ≤ -3% (n≥50) gemute (weight=0)<br>
    • Adaptive MIN_EDGE: 8% voor onbewezen markten, 6.5% early, 5.5% proven<br>
    • Bootstrap mode: 5.5% overal tot 100 totaal settled bets<br>
    • Drift detection: alert als markt/signal recent verslechtert</div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">6. Point-in-time logging (v2 pipeline)</strong><br>
    12 Supabase tabellen voor reproduceerbaarheid: fixtures, odds_snapshots (90-min polling + kickoff windows), feature_snapshots, market_consensus, model_runs, pick_candidates (incl. rejected_reason), signal_stats, training_examples. Walk-forward backtest endpoint actief.</div>
    <div><strong style="color:var(--text)">7. Experimentele signalen (logged-only, auto-activate)</strong><br>
    Sommige signalen worden verzameld maar staan op weight=0 (geen scoring impact). Zodra n≥50 picks met dat signaal én avg CLV > 0%, wordt het automatisch geactiveerd op weight 0.5. Web-push/inbox melding bij activatie.<br>
    • <code style="background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:11.5px">nba_rest_days_diff</code> — rest-days verschil home vs away (NBA, sinds v10.4.1)<br>
    • <code style="background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:11.5px">nfl_injury_diff</code> — blessure-aantal verschil home vs away (NFL, sinds v10.4.1)<br>
    Status zichtbaar op Model-tab onder "Huidige Signal Gewichten".</div>
  `,
  // Sport names (JS maps)
  sport_hockey_full: '🏒 IJshockey',
  sport_baseball_full: '⚾ Honkbal',
  sport_football_full: '⚽ Voetbal',
  sport_basketball_full: '🏀 Basketball',
  sport_nfl_full: '🏈 NFL',
  sport_handball_full: '🤾 Handbal',
  // Signal names (JS maps)
  sig_home_adv: 'Thuisvoordeel',
  sig_form: 'Vorm',
  sig_injuries: 'Blessures',
  sig_h2h: 'Head-to-head',
  sig_position: 'Positie',
  sig_home_away_split: 'Thuis/uit split',
  sig_api_pred: 'API predictie',
  sig_lineup: 'Opstelling',
  sig_team_stats: 'Team stats',
  sig_btts_scoring: 'BTTS scoring',
  sig_btts_cleansheet: 'BTTS clean sheet',
  // Outcome / form options
  outcome_open: 'Open',
  outcome_win: 'Win',
  outcome_loss: 'Loss',
  bookie_any: 'Elke bookie',
  // Toggle labels
  toggle_expand: '▼ Uitklappen',
  toggle_collapse: '▲ Inklappen',
  toggle_show_analysis: '▼ analyse',
  toggle_hide_analysis: '▲ verberg analyse',
  // Empty states
  empty_signal_data: 'Nog geen signal data',
  empty_market_data: 'Nog geen calibratiedata',
  empty_per_sport: 'Nog geen data per sport',
  empty_settled_bets: 'Nog geen settled bets.',
  empty_signal_analysis: 'Signal data verschijnt na picks met signal tracking (nieuwe scans).',
  error_signal_load: 'Signal analyse laden mislukt.',
  // POTD
  btn_potd: '📝 Genereer POTD post',
  btn_previous_scans: 'PREVIOUS SCANS',
  btn_previous_scans_toggle: 'toon',
  // ─── Phase 4: toasts, modals, errors ───
  err_prefix: 'Fout: ',
  err_network: 'Netwerkfout',
  err_connection: '❌ Verbindingsfout: ',
  err_conn_short: 'Verbindingsfout',
  err_load_failed: 'Fout bij laden',
  err_fetch_failed: 'Fout bij ophalen',
  err_unknown: 'onbekend',
  err_model_log: 'Fout bij ophalen model log.',
  err_v2_load: 'Fout bij laden v2 data: ',
  err_password_empty: 'Vul huidig en nieuw wachtwoord in',
  err_add_bet_empty: '⚠️ Vul wedstrijd, odds en units in.',
  err_odds_empty: '⚠️ Vul odds in.',
  loading: 'Laden…',
  loading_dots: 'Laden...',
  loading_fetch: 'Ophalen...',
  busy: '⏳ Bezig...',
  confirm_remove_bet: 'Bet #{id} verwijderen?',
  confirm_clv_backfill: 'CLV aanvullen voor alle bets met lege closing line? Kan 10-30 sec duren.',
  drift_title: 'MARKT DRIFT (laatste {window} vs all-time):',
  drift_no_data: 'geen data',
  action_enable: 'aanzetten',
  action_disable: 'uitzetten',
  btn_close_live: '⚡ Sluiten',
  prompt_new_odds: 'Nieuwe odds',
  prompt_new_units: 'Nieuwe units',
  prompt_sport: 'Sport (was {val}):\n{list}',
  prompt_bookie: 'Bookmaker (was {val}):\n{list}',
  fill_times_btn: '⏰ Tijden invullen',
  bets_updated: 'bijgewerkt',
  bets_not_found: 'niet gevonden',
});
Object.assign(LANG.en, {
  picks_none: 'No confident picks today',
  picks_count: 'confident pick',
  picks_only_these: 'bet only these',
  picks_see_also: 'See also:',
  notif_detail_title: 'Notification',
  settings_title: 'Settings',
  settings_back: 'Back',
  nav_settings: 'Settings',
  prof_account: 'Account',
  prof_logged_in_as: 'Logged in as',
  prof_bankroll: 'Bankroll & stake',
  prof_start_bankroll: 'Start bankroll (€)',
  prof_unit_size: 'Unit size (€)',
  prof_scan_times: 'Daily scan times',
  prof_scan_times_desc: 'Select hours when the scan runs automatically and sends picks to your device (web-push + inbox)',
  prof_scan_enabled: 'Automatic scans enabled',
  prof_lang_region: 'Language & region',
  prof_language: 'Language',
  prof_timezone: 'Timezone',
  prof_change_pw: 'Change password',
  prof_cur_pw: 'Current password',
  prof_new_pw: 'New password (min. 8 chars)',
  prof_change_pw_btn: 'Change password',
  prof_save: 'Save',
  prof_logout: 'Log out',
  analyze_title: '\ud83d\udd0d Match Analyzer',
  analyze_btn: 'Analyze',
  analyze_placeholder: 'E.g.: Ajax PSV over 2.5',
  analyze_help: 'Type a match + market. Examples: "Liverpool Arsenal over 2.5", "Bayern btts", "Ajax PSV draw"',
  analyze_busy: 'Analyzing...',
  analyze_analyzing: 'Analyzing...',
  analyze_failed: 'Analysis failed',
  analyze_no_edge: 'No edge found. The bookmaker odds appear correctly priced.',
  analyze_form: 'Form',
  analyze_standings: 'Standings',
  analyze_h2h: 'Head to head',
  analyze_injuries: 'Injuries',
  analyze_weather: 'Weather',
  analyze_all_markets: 'All markets analyzed',
  analyze_log: '+ Log',
  pot_win_today: 'Pot. profit today',
  pot_risk_today: 'Risk',
  sport_football: 'Football',
  sport_basketball: 'Basketball',
  sport_hockey: 'Hockey',
  sport_baseball: 'Baseball',
  sport_nfl: 'NFL',
  sport_handball: 'Handball',
  api_total: 'Total',
  api_budget_reset: 'Budget resets daily at midnight UTC. Average usage: ~200-400 calls per scan.',
  api_budget_high: 'High usage — limit manual rescans.',
  // ─── v10.5 i18n expansion ───
  nav_model: 'Model',
  card_recent_bets: 'Recent bets',
  card_model_health: 'Model health',
  card_fetch_results: '🔄 Fetch results',
  card_add_bet: '+ Add bet',
  card_bankroll: '📈 Bankroll trend',
  card_outcomes: '🎯 Outcomes',
  card_per_sport: '⚽ Per sport',
  card_hitrate_score: '📊 Hit rate by score',
  card_hitrate_market: '🎲 Hit rate by market',
  card_clv: '📉 Closing Line Value',
  card_variance: '🎲 Variance tracker',
  card_signal_attribution: '🧠 Signal attribution',
  card_signal_attribution_sub: 'Hit rate per signal — which signals deliver real edge.',
  card_timing: '⏱️ Timing analysis',
  card_analyzer: '🔍 Match analyzer',
  card_search_scan: '🔍 Search last scan results',
  card_inbox: '📬 Inbox',
  card_signal_weights: '🔧 Current signal weights',
  card_signal_weights_sub: 'Weights auto-adjust based on performance. 1.0 = neutral, >1.0 = amplified, <1.0 = dampened, 0 = inactive (logged-only).',
  card_market_multipliers: '📊 Market multipliers',
  card_market_multipliers_sub: 'Calibration per market type after 8+ bets. Higher = model trusts this market more.',
  card_per_sport_sub: 'Win rate and P/L per sport, based on settled bets.',
  card_model_updates: '🧠 Model updates',
  card_experimental: '🧪 Experimental signals',
  card_experimental_sub: 'Collected on every scan but kept at weight=0 (no scoring impact). Auto-activate to 0.5 once n≥50 picks + avg CLV > 0%. Web-push + inbox notification on activation.',
  card_v2_health: '🧪 v2 Pipeline Health',
  card_service_status: '🟢 Service status',
  card_api_budget: '📊 API budget',
  card_model_status: '🧠 Model status',
  card_leagues: '⚽ Leagues',
  card_how_it_works: '🎯 EdgePickr — how it works',
  card_model_explained: '🧠 The model explained',
  card_datasources: '📡 Data sources',
  card_bet_strategy: '💰 Bet strategy',
  card_subscriptions: '💳 Subscriptions',
  card_changelog: '📝 Changelog',
  info_subtitle: 'Data-driven sports betting',
  info_date: 'April 2026',
  info_intro: 'EdgePickr is a <strong>quantitative market-disagreement engine</strong> for 6 sports. Market = baseline truth, model = residual overlay. Fully autonomous with point-in-time snapshots, CLV-first KPI, kill-switch enforcement, and a minimal set of operator failsafes for emergencies. Goal: systematically find mispricings, not "predict who will win".',
  info_model_body: `
    <div style="margin-bottom:10px"><strong style="color:var(--text)">1. Market consensus as baseline</strong><br>
    For each fixture, all bookmaker odds are devigged (margin removed) → fair market probability. This is the "truth anchor".</div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">2. Model = residual overlay (not replacement)</strong><br>
    Per-sport Poisson/regression overlay that adjusts the market baseline. Final prob = market + delta. Sanity check: >4% divergence between model and market → pick is rejected.</div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">3. Sport-specific signals</strong><br>
    <ul style="padding-left:18px;margin-top:6px;column-count:2;column-gap:24px">
      <li>Football: form, H2H, injuries, lineup, ref, predictions, weather, Poisson goals</li>
      <li>NHL: shots differential (nhl.com), home ice, b2b, 3-way Poisson</li>
      <li>MLB: starting pitcher ERA (statsapi.mlb.com), F5 market</li>
      <li>NBA: pace/PPG, rebound diff, home split</li>
      <li>NFL: bye week, division rivalry, points diff</li>
      <li>Handball: 3-way Poisson, momentum</li>
      <li>Hierarchical calibration: global → sport → market → league</li>
      <li>Per-signal CLV autotune (faster than W/L)</li>
    </ul>
    </div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">4. Half-Kelly + diversification</strong><br>
    <code style="background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:11.5px">k = (ep×(odd-1) − (1−ep)) / (odd-1) × 0.5</code><br>
    Markets: Moneyline, 3-way ML 60-min (hockey/handball), Totals, Spreads, Team Totals, BTTS, Double Chance, DNB, F5 (MLB), 1st Period O/U.<br>
    Diversification: max 1 pick per match, max 2 per sport per day, max 5 picks/day total.</div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">5. Discipline mechanisms (auto)</strong><br>
    • Kill-switch: markets with avg CLV < -5% (n≥30) auto-disabled<br>
    • Signal kill: signals with avg CLV ≤ -3% (n≥50) muted (weight=0)<br>
    • Adaptive MIN_EDGE: 8% for unproven markets, 6.5% early, 5.5% proven<br>
    • Bootstrap mode: 5.5% everywhere until 100 total settled bets<br>
    • Drift detection: alert if market/signal recently degrades</div>
    <div style="margin-bottom:10px"><strong style="color:var(--text)">6. Point-in-time logging (v2 pipeline)</strong><br>
    12 Supabase tables for reproducibility: fixtures, odds_snapshots (90-min polling + kickoff windows), feature_snapshots, market_consensus, model_runs, pick_candidates (incl. rejected_reason), signal_stats, training_examples. Walk-forward backtest endpoint active.</div>
    <div><strong style="color:var(--text)">7. Experimental signals (logged-only, auto-activate)</strong><br>
    Some signals are collected but kept at weight=0 (no scoring impact). Once n≥50 picks with that signal plus avg CLV > 0%, it auto-activates at weight 0.5. Web-push/inbox notification on activation.<br>
    • <code style="background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:11.5px">nba_rest_days_diff</code> — rest-days difference home vs away (NBA, since v10.4.1)<br>
    • <code style="background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:11.5px">nfl_injury_diff</code> — injury count difference home vs away (NFL, since v10.4.1)<br>
    Status visible on Model tab under "Current signal weights".</div>
  `,
  // Sport names
  sport_hockey_full: '🏒 Ice hockey',
  sport_baseball_full: '⚾ Baseball',
  sport_football_full: '⚽ Football',
  sport_basketball_full: '🏀 Basketball',
  sport_nfl_full: '🏈 NFL',
  sport_handball_full: '🤾 Handball',
  // Signal names
  sig_home_adv: 'Home advantage',
  sig_form: 'Form',
  sig_injuries: 'Injuries',
  sig_h2h: 'Head-to-head',
  sig_position: 'Position',
  sig_home_away_split: 'Home/away split',
  sig_api_pred: 'API prediction',
  sig_lineup: 'Lineup',
  sig_team_stats: 'Team stats',
  sig_btts_scoring: 'BTTS scoring',
  sig_btts_cleansheet: 'BTTS clean sheet',
  // Outcome / form options
  outcome_open: 'Open',
  outcome_win: 'Win',
  outcome_loss: 'Loss',
  bookie_any: 'Any bookie',
  // Toggle labels
  toggle_expand: '▼ Expand',
  toggle_collapse: '▲ Collapse',
  toggle_show_analysis: '▼ analysis',
  toggle_hide_analysis: '▲ hide analysis',
  // Empty states
  empty_signal_data: 'No signal data yet',
  empty_market_data: 'No calibration data yet',
  empty_per_sport: 'No per-sport data yet',
  empty_settled_bets: 'No settled bets yet.',
  empty_signal_analysis: 'Signal data appears after picks with signal tracking (new scans).',
  error_signal_load: 'Failed to load signal analysis.',
  // POTD
  btn_potd: '📝 Generate POTD post',
  btn_previous_scans: 'PREVIOUS SCANS',
  btn_previous_scans_toggle: 'show',
  // ─── Phase 4: toasts, modals, errors ───
  err_prefix: 'Error: ',
  err_network: 'Network error',
  err_connection: '❌ Connection error: ',
  err_conn_short: 'Connection error',
  err_load_failed: 'Failed to load',
  err_fetch_failed: 'Failed to fetch',
  err_unknown: 'unknown',
  err_model_log: 'Failed to load model log.',
  err_v2_load: 'Failed to load v2 data: ',
  err_password_empty: 'Enter current and new password',
  err_add_bet_empty: '⚠️ Fill in match, odds and units.',
  err_odds_empty: '⚠️ Fill in odds.',
  loading: 'Loading…',
  loading_dots: 'Loading...',
  loading_fetch: 'Fetching...',
  busy: '⏳ Working...',
  confirm_remove_bet: 'Delete bet #{id}?',
  confirm_clv_backfill: 'Backfill CLV for all bets with empty closing line? May take 10-30 sec.',
  drift_title: 'MARKET DRIFT (last {window} vs all-time):',
  drift_no_data: 'no data',
  action_enable: 'enable',
  action_disable: 'disable',
  btn_close_live: '⚡ Close',
  prompt_new_odds: 'New odds',
  prompt_new_units: 'New units',
  prompt_sport: 'Sport (was {val}):\n{list}',
  prompt_bookie: 'Bookmaker (was {val}):\n{list}',
  fill_times_btn: '⏰ Fill kickoff times',
  bets_updated: 'updated',
  bets_not_found: 'not found',
});

// v10.7.21: userSettings leeft in index.html inline <script>; lang.js kan
// geladen zijn voor die declaratie. Safe accessor voorkomt TDZ ReferenceError.
function _getLang() {
  try { return (typeof userSettings !== 'undefined' && userSettings?.language) || 'nl'; }
  catch { return 'nl'; }
}

function t(key) {
  const lang = _getLang();
  return LANG[lang]?.[key] ?? LANG.nl[key] ?? key;
}

function applyLanguage() {
  const lang = _getLang();
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = LANG[lang]?.[key];
    if (val) el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    const val = LANG[lang]?.[key];
    if (val) el.innerHTML = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = LANG[lang]?.[key];
    if (val) el.placeholder = val;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const val = LANG[lang]?.[key];
    if (val) el.title = val;
  });
}
