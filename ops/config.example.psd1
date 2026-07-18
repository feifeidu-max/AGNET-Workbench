@{
    # Leave command paths blank to resolve them from PATH. Absolute paths are
    # recommended for Task Scheduler installations.
    NodeExecutable       = ""
    HermesExecutable     = "hermes"
    LlmWikiExecutable    = ""
    # Empty uses apps\llm-wiki\mcp-server\dist\src\index.js from this repo.
    LlmWikiMcpEntrypoint = ""

    StudioPort           = 8648
    LlmWikiPort          = 19828
    HermesGatewayPort    = 8642

    # Empty HermesHome uses the same Windows discovery order as Studio:
    # %LOCALAPPDATA%\hermes, %APPDATA%\hermes, then %USERPROFILE%\.hermes.
    HermesHome           = ""
    StudioDataHome       = "%USERPROFILE%\.hermes-web-ui"
    CompanyMetricsDbPath = ""

    # Add every LLM Wiki project that must be backed up. Paths may contain
    # Windows environment variables. Missing paths are reported and skipped.
    WikiProjectPaths     = @(
        "%USERPROFILE%\Documents\LLM-Wiki"
    )
    # Projects created from the Studio LLM Wiki workbench are stored here.
    # They are discovered automatically for startup registration and backup.
    LlmWikiManagedProjectsHome = "%APPDATA%\com.llmwiki.app\studio-projects"

    BackupRoot           = "D:\AGNET-Backups"
    RetentionCount       = 30
    DailyBackupTime      = "18:00"

    # The secret itself must be stored in this user environment variable. It
    # is inherited by LLM Wiki and Studio but is never written to this file.
    LlmWikiTokenEnvironmentVariable = "AGNET_LLM_WIKI_API_TOKEN"
}
