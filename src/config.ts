/** Azure AD app (SPA) client id — fill in before Connect Excel works. */
export const MS_CLIENT_ID = "";

/** Personal Microsoft accounts only. */
export const MS_AUTHORITY = "https://login.microsoftonline.com/consumers";

/** GitHub Pages redirect URI for this SPA. */
export const MS_REDIRECT_URI = "https://kellybyron2222-dev.github.io/VerticalJumpAnalysis/";

export const MS_SCOPES = ["Files.ReadWrite", "offline_access", "User.Read"] as const;

export const DEFAULT_WORKBOOK_PATH =
  "/me/drive/root:/Documents/Training Logs/2026_P6_Reload_and_C1_v5.xlsx";
export const DEFAULT_WORKSHEET = "Jump Test";
/** Header row for Friday drop jumps; data starts on the next row. */
export const DEFAULT_HEADER_ROW = 23;
