# Meteo Plotiště

Osobný meteo dashboard pre Plotiště nad Labem (Hradec Králové).

- **Okno Európa:** mapa nárazov vetra, zrážok, búrkového potenciálu (CAPE) a izobár na 5 dní, automatická detekcia tlakových níží, ich dráhy a vzdialenosť od Plotišťa.
- **Okno Plotiště:** aktuálne počasie, porovnanie 6 modelov (ECMWF, ICON, GFS, Météo-France, UKMO, GEM), ensemble pásma a pravdepodobnosti javov na 7 dní.

Dáta sa načítavajú priamo v prehliadači z [Open-Meteo](https://open-meteo.com) (zadarmo, bez kľúča).
Ak sa nedajú načítať, stránka zobrazí jasne označené ukážkové dáta.

## Spustenie

Stačí statický hosting. Na GitHube: **Settings → Pages → Deploy from branch → `main` / root**.
Stránka potom beží na `https://<používateľ>.github.io/meteo-plotiste/`.

Lokálne: `python3 -m http.server` v tomto priečinku a otvoriť http://localhost:8000.
