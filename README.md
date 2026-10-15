# Hand Cricket: Veer's League, online server

Put `index.html`, `server.js` and `package.json` in one folder.

Run on your computer:
    npm install
    npm start          (opens on http://localhost:3000)

Players on the same Wi-Fi open http://YOUR-COMPUTER-IP:3000 on their phones.

Put it on the internet (free): create a GitHub repository with these three files,
then on render.com choose New > Web Service, connect the repository and set
  Build command: npm install
  Start command: npm start
Render gives you an address like https://your-game.onrender.com.
Open that address: the game loads from it and Play Online connects automatically.
(Free Render services sleep when idle; the first visit can take about a minute.)
