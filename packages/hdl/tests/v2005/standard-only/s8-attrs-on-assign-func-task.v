// annex: A.9.1 attribute-instance; A.1.5 module-or-generate-item; A.6.1 continuous-assign; A.2.6 function-declaration; A.2.7 task-declaration; A.2.1.3 genvar-declaration; A.6.2 initial-construct; A.6.4 statement
// iverilog: rejects (syntax error / Invalid module item. for an attribute before assign, function, task or genvar, and before the statement of initial)
module attr_items (input a, output y);
    (* assign_attr *) assign y = a;
    (* func_attr *) function f;
        input x;
        f = x;
    endfunction
    (* task_attr *) task t;
        ;
    endtask
    (* genvar_attr *) genvar gv;
    reg r;
    initial (* stmt_attr *) begin
        r = 1;
    end
    initial (* stmt_attr2 *) r = 0;
endmodule
