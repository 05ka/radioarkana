const player = document.getElementById("radioPlayer");
const button = document.getElementById("playButton");
const indicator = document.getElementById("liveIndicator");
const liveText = document.getElementById("liveText");

button.addEventListener("click", () => {
  player.play()
    .then(() => {
      indicator.classList.remove("live-off");
      indicator.classList.add("live-on");
      liveText.textContent = "EN DIRECTO";
    })
    .catch(err => {
      console.log("Error al reproducir:", err);
    });
});

player.addEventListener("pause", () => {
  indicator.classList.remove("live-on");
  indicator.classList.add("live-off");
  liveText.textContent = "Desconectado";
});

player.addEventListener("ended", () => {
  indicator.classList.remove("live-on");
  indicator.classList.add("live-off");
  liveText.textContent = "Desconectado";
});
