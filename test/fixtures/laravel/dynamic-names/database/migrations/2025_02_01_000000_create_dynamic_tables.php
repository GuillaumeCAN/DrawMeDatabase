<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $tableNames = config('permission.table_names');
        $suffix = 'archive';

        Schema::create($tableNames['roles'], function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->string('name');
        });

        Schema::create('logs_' . $suffix, function (Blueprint $table) {
            $table->id();
        });

        Schema::create("{$suffix}_events", function (Blueprint $table) {
            $table->id();
        });

        Schema::create('measures', function (Blueprint $table) {
            $table->id();
            foreach (['width', 'height'] as $dimension) {
                $table->integer($dimension);
            }
            $table->string('unit', 8);
            $table->foreignId('owner_id')->constrained(config('auth.table'));
            $table->userstamps();
        });

        Schema::table('users', function (Blueprint $table) {
            $table->string('locale', 5)->default('en');
            $table->renameColumn('surname', 'last_name');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('measures');
    }
};
