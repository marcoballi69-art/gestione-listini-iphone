GESTIONE LISTINI IPHONE — REVISIONE 4

BASE
- Derivata dalla revisione 3 caricata dall’utente.
- Da pubblicare esclusivamente nel repository gestione-listini-iphone.
- Non modificare il repository gestione-listini-test né la V.24 stabile.

MODIFICHE
1. Archivio articoli permanente separato dal listino attuale, con conservazione su IndexedDB.
2. In ALTRO è presente il pulsante LISTA ARCHIVIO ARTICOLI.
3. È possibile aggiungere progressivamente una variante indicando articolo principale, serie/disegno e codice.
4. Le diciture S.1 e SERIE 1 vengono normalizzate come SERIE 1.
5. Le varianti archiviate ereditano il prezzo dall’articolo principale nel listino attuale. Se il principale non è nel listino attuale, la variante resta selezionabile e mostra PREZZO ASSENTE.
6. Ricerca e scanner riconoscono anche i codici presenti nell’archivio permanente.
7. Importando PDF, Excel o CSV il nuovo listino sostituisce il precedente; archivio permanente e selezioni salvate restano separati.
8. Backup JSON include anche l’archivio permanente.
9. Per PDF con dati tabellari sulla stessa riga, il parser conserva i valori successivi al prezzo e li mostra con etichette Composizione, Peso e Altezze. I valori numerici successivi al prezzo sono raccolti nel campo Peso.
10. Cache aggiornata alla revisione 4.

DA PROVARE
- Aggiungere SPRINT / S.1 / codice e poi SPRINT / SERIE 2 / codice.
- Caricare un listino con SPRINT e verificare che le due varianti mostrino il prezzo SPRINT.
- Caricare un nuovo listino senza SPRINT e verificare PREZZO ASSENTE, mantenendo selezionabili le varianti.
- Verificare import Excel e PDF reali, soprattutto la corrispondenza dei campi Peso e Altezze.
- Verificare backup e ripristino su un dispositivo di prova.

INSTALLAZIONE
Caricare il contenuto dello ZIP nel repository separato gestione-listini-iphone. Non caricarlo nel repository gestione-listini-test.
