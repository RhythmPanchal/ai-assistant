import { runAgent } from "../../agent/agent";
import pendingTasksKnowledge from "../../knowledge/pendingTasksKnowledge";
import taskLogKnowledge from "../../knowledge/taskLogKnowledge";

export async function goodMorningJob(){
    //TODO : fix this, run for all users. 
    const userId = 1136575387 ; //temp. hardconding 
    
    //fetch the pending tasks. 
    const pendingTasks = await collection
        .find({
            userId: userId,
            status : "Pending"
        })
        .sort({ priorityScore : -1 }) // newest → oldest
        .toArray();

    const MorningInstruction = `
        You need to create an optimal schedule for today, with a fine good morning message.
${pendingTasksKnowledge}

Step 1: Analyze past 7 days
${taskLogKnowledge}
I have given past 7 days task done by user use that.
* Identify patterns:
  → When user is most productive
  → Types of tasks completed (work/personal/health)
  → Any delays or incomplete patterns

Step 2: Understand constraints
* If weekday:
  → User is mostly in office during 10AM to 8PM.
  → during office hours mostly done office tasks, some time office tasks come unexpectedly sometimes It is organised.
* If weekend:
  → User some times go to tour/explore.
  → Assign more personal + deep work tasks

Step 3: Prioritize tasks
* High priority + urgent → earliest slots
* Medium → flexible slots
* Low → optional / end of day

Step 4: Output format
* Clean and structured timeline
* Include time ranges (approximate is fine)
* Mention task name + short purpose

Important rules:
* Optimize for productivity + realism
* If very few tasks → include self-improvement or maintenance tasks

Goal:
Create a practical, realistic, and optimized day plan tailored to the user’s behavior and constraints, along with a motivational message.
    `
    let res; 
    try{
        const goodMorningMessage = await runAgent(userId,MorningInstruction);
        res = sendMessage(goodMorningMessage);
    }catch(error){
        throw new Error("Caught error while running Good morning job :" , error); 
    }
     
    return res; 
}


