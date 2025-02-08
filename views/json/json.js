// Copy JSON data to clipboard
document.getElementById('copy-btn').addEventListener('click', () => {
    const jsonText = JSON.stringify(jsonData, null, 2);
    navigator.clipboard.writeText(jsonText).then(() => {
      showToast("Code JSON copié avec succès !");
    }).catch(err => {
      console.error("Erreur lors de la copie :", err);
    });
});

// Show toast notification
function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 4000);
}

document.getElementById("jsonData").textContent = JSON.stringify(jsonData, null, 2);