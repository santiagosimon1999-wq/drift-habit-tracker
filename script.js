const habitInput = document.getElementById("habit-input");
const addHabitButton = document.getElementById("add-habit-button");

addHabitButton.addEventListener("click", function () {
    console.log(habitInput.value);
});