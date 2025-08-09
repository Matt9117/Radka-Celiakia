
# Radka Scanner (APK auto-build, camera ready)

Tento ZIP obsahuje workflow, ktorý automaticky PATCHne AndroidManifest.xml a pridá CAMERA povolenie pri builde.
Výsledkom je **app-debug.apk** bez nutnosti Android Studia.

## Kroky
1. Vytvor repo na GitHube (napr. `RadkaScanner`) a nahraj SEM rozbalený obsah tohto ZIPu.
2. V karte **Actions** sa spustí workflow **Android APK**.
3. Po dobehnutí si v **Artifacts** stiahni `app-debug.apk`.

Zmena názvu/ID aplikácie: uprav `capacitor.config.ts` a pushni zmeny.
